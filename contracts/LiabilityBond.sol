// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ILiabilityBond} from "./interfaces/ILiabilityBond.sol";

/**
 * @title LiabilityBond
 * @notice Neutral custodian of each actor's staked collateral.
 *
 *  - **Throughput-sized locks.** Creating a lot locks `bondPerUnit * quantity` of the
 *    producer's free bond for `liabilityPeriod`. An actor therefore cannot produce more
 *    than its bond covers, and cannot withdraw collateral backing lots that could still
 *    be recalled (closing the "withdraw before the recall lands" escape).
 *  - **Topology-keyed slashing.** A recall slashes the lock posted for the recalled root
 *    lot, so the penalty scales with the size of the defective lot.
 *  - **Settlement.** Escrow is paid pro-rata to downstream holders. A holder whose
 *    address rejects ETH is credited (pull) instead of blocking everyone else, and the
 *    last recipient absorbs integer-division dust so the whole pot is paid out.
 */
contract LiabilityBond is ILiabilityBond, Ownable, ReentrancyGuard {
    struct LotLock {
        address owner;
        uint256 size;      // original lock (bondPerUnit * quantity at creation)
        uint256 remaining; // not yet released or slashed
        uint256 unlockAt;
    }

    /// @dev Gas forwarded on payout transfers: enough for smart-wallet receive hooks,
    ///      not enough for a malicious holder to grief the whole settlement.
    uint256 private constant PAYOUT_GAS = 50_000;

    address public recallEngine;
    address public lotRegistry;
    uint256 public bondPerUnit;               // collateral required per unit produced
    uint256 public liabilityPeriod = 30 days; // how long a lot's lock backs a recall

    mapping(address => uint256) private _bonds;       // free (withdrawable) bond per actor
    mapping(address => uint256) private _lockedTotal; // locked bond per actor
    mapping(uint256 => LotLock) private _locks;       // lotId => lock
    mapping(uint256 => uint256) private _escrow;      // recallId => amount held for payout
    mapping(address => uint256) private _claimable;   // credited payouts (failed pushes)

    modifier onlyRecallEngine() {
        require(msg.sender == recallEngine, "only RecallEngine");
        _;
    }

    modifier onlyLotRegistry() {
        require(msg.sender == lotRegistry, "only LotRegistry");
        _;
    }

    constructor(address owner_) Ownable(owner_) {}

    // --- admin wiring / parameters ---

    function setRecallEngine(address engine) external onlyOwner {
        recallEngine = engine;
    }

    function setLotRegistry(address registry) external onlyOwner {
        lotRegistry = registry;
    }

    /// @notice Collateral per unit produced. Applies to lots created after the change.
    function setBondPerUnit(uint256 amount) external onlyOwner {
        bondPerUnit = amount;
    }

    /// @notice Liability period for lots created after the change.
    function setLiabilityPeriod(uint256 period) external onlyOwner {
        liabilityPeriod = period;
    }

    // --- staking ---

    /// @inheritdoc ILiabilityBond
    function stakeBond() external payable {
        require(msg.value > 0, "no value");
        _bonds[msg.sender] += msg.value;
        emit BondStaked(msg.sender, msg.value);
    }

    /// @inheritdoc ILiabilityBond
    function withdrawBond(uint256 amount) external nonReentrant {
        require(_bonds[msg.sender] >= amount, "insufficient bond");
        _bonds[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        emit BondWithdrawn(msg.sender, amount);
    }

    /// @inheritdoc ILiabilityBond
    function bondOf(address actor) external view returns (uint256) {
        return _bonds[actor];
    }

    /// @inheritdoc ILiabilityBond
    function lockedOf(address actor) external view returns (uint256) {
        return _lockedTotal[actor];
    }

    /// @inheritdoc ILiabilityBond
    function lotLock(uint256 lotId)
        external
        view
        returns (address owner, uint256 size, uint256 remaining, uint256 unlockAt)
    {
        LotLock storage l = _locks[lotId];
        return (l.owner, l.size, l.remaining, l.unlockAt);
    }

    // --- per-lot locks ---

    /// @inheritdoc ILiabilityBond
    function lockForLot(address actor, uint256 lotId, uint256 quantity) external onlyLotRegistry {
        require(_locks[lotId].owner == address(0), "already locked");
        uint256 amount = bondPerUnit * quantity;
        require(_bonds[actor] >= amount, "insufficient bond");
        _bonds[actor] -= amount;
        _lockedTotal[actor] += amount;
        uint256 unlockAt = block.timestamp + liabilityPeriod;
        _locks[lotId] = LotLock({owner: actor, size: amount, remaining: amount, unlockAt: unlockAt});
        emit BondLocked(actor, lotId, amount, unlockAt);
    }

    /// @inheritdoc ILiabilityBond
    function releaseLot(uint256 lotId) external {
        LotLock storage l = _locks[lotId];
        require(l.remaining > 0, "nothing locked");
        require(block.timestamp >= l.unlockAt, "liability period active");
        uint256 amount = l.remaining;
        l.remaining = 0;
        _lockedTotal[l.owner] -= amount;
        _bonds[l.owner] += amount;
        emit BondReleased(l.owner, lotId, amount);
    }

    // --- recall settlement (RecallEngine only) ---

    /// @inheritdoc ILiabilityBond
    function slashForLot(address actor, uint256 lotId, uint256 recallId)
        external
        onlyRecallEngine
        returns (uint256 slashed)
    {
        LotLock storage l = _locks[lotId];
        uint256 target = l.size;

        // 1. Take from the lock posted for this lot.
        uint256 fromLock = l.remaining < target ? l.remaining : target;
        if (fromLock > 0) {
            l.remaining -= fromLock;
            _lockedTotal[l.owner] -= fromLock;
        }

        // 2. If the lock was already released (recall after the liability period), fall
        //    back to the producer's free bond, capped at what is available.
        uint256 rest = target - fromLock;
        uint256 fromFree = rest > _bonds[actor] ? _bonds[actor] : rest;
        _bonds[actor] -= fromFree;

        slashed = fromLock + fromFree;
        _escrow[recallId] += slashed;
        emit BondSlashed(actor, slashed, recallId);
    }

    /// @inheritdoc ILiabilityBond
    function distributePayout(uint256 recallId, address[] calldata holders, uint256[] calldata weights)
        external
        onlyRecallEngine
        nonReentrant
    {
        require(holders.length == weights.length, "length mismatch");
        uint256 pot = _escrow[recallId];
        if (pot == 0 || holders.length == 0) {
            emit PayoutDistributed(recallId, 0, 0);
            return;
        }

        uint256 totalWeight;
        for (uint256 i = 0; i < weights.length; i++) {
            totalWeight += weights[i];
        }
        require(totalWeight > 0, "no weight");

        _escrow[recallId] = 0; // effects before interactions
        uint256 distributed;
        uint256 last = holders.length - 1;
        for (uint256 i = 0; i < holders.length; i++) {
            // The last entry absorbs rounding dust so exactly `pot` leaves escrow.
            uint256 share = i == last ? pot - distributed : (pot * weights[i]) / totalWeight;
            distributed += share;
            if (share > 0) _send(recallId, holders[i], share);
        }
        emit PayoutDistributed(recallId, distributed, holders.length);
    }

    /// @inheritdoc ILiabilityBond
    function refundEscrow(uint256 recallId, address to)
        external
        onlyRecallEngine
        returns (uint256 amount)
    {
        amount = _escrow[recallId];
        _escrow[recallId] = 0;
        _bonds[to] += amount; // credited back to free bond; the actor may withdraw it
        emit BondRefunded(to, amount, recallId);
    }

    /// @inheritdoc ILiabilityBond
    function payFromEscrow(uint256 recallId, address to, uint256 amount)
        external
        onlyRecallEngine
        nonReentrant
    {
        require(_escrow[recallId] >= amount, "escrow underflow");
        _escrow[recallId] -= amount; // effects before interaction
        _send(recallId, to, amount);
    }

    /// @inheritdoc ILiabilityBond
    function escrowOf(uint256 recallId) external view returns (uint256) {
        return _escrow[recallId];
    }

    // --- credited payouts ---

    /// @inheritdoc ILiabilityBond
    function claimableOf(address holder) external view returns (uint256) {
        return _claimable[holder];
    }

    /// @inheritdoc ILiabilityBond
    function withdrawClaimable() external nonReentrant {
        uint256 amount = _claimable[msg.sender];
        require(amount > 0, "nothing claimable");
        _claimable[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        emit ClaimableWithdrawn(msg.sender, amount);
    }

    /// @dev Push `amount` to `to`; if the transfer fails, credit it for later withdrawal
    ///      so one rejecting holder cannot block settlement for everyone else.
    function _send(uint256 recallId, address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount, gas: PAYOUT_GAS}("");
        if (ok) {
            emit ClaimPaid(recallId, to, amount);
        } else {
            _claimable[to] += amount;
            emit PayoutCredited(recallId, to, amount);
        }
    }

    receive() external payable {}
}
