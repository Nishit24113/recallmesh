// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ILiabilityBond} from "./interfaces/ILiabilityBond.sol";

/**
 * @title LiabilityBond
 * @notice Neutral custodian of each actor's staked collateral. On a recall, only
 *         the RecallEngine may slash an actor's bond into a per-recall escrow and
 *         later distribute that escrow pro-rata to downstream holders. Because the
 *         contract (not any party) holds the funds, settlement is impartial.
 * @dev Draft: bond sizing, partial slashing policy, and division dust handling are
 *      left as parameters/TODOs for the implementation phase.
 */
contract LiabilityBond is ILiabilityBond, Ownable, ReentrancyGuard {
    address public recallEngine;

    mapping(address => uint256) private _bonds;  // free (withdrawable) bond per actor
    mapping(uint256 => uint256) private _escrow; // recallId => amount held for payout

    modifier onlyRecallEngine() {
        require(msg.sender == recallEngine, "only RecallEngine");
        _;
    }

    constructor(address owner_) Ownable(owner_) {}

    function setRecallEngine(address engine) external onlyOwner {
        recallEngine = engine;
    }

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
    function slashAndEscrow(address actor, uint256 amount, uint256 recallId)
        external
        onlyRecallEngine
        returns (uint256 slashed)
    {
        slashed = amount > _bonds[actor] ? _bonds[actor] : amount; // cap at available bond
        _bonds[actor] -= slashed;
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
        require(pot > 0, "no escrow");

        uint256 totalWeight;
        for (uint256 i = 0; i < weights.length; i++) {
            totalWeight += weights[i];
        }
        require(totalWeight > 0, "no weight");

        _escrow[recallId] = 0; // effects before interactions
        uint256 distributed;
        for (uint256 i = 0; i < holders.length; i++) {
            uint256 share = (pot * weights[i]) / totalWeight;
            if (share == 0) continue;
            distributed += share;
            (bool ok, ) = holders[i].call{value: share}("");
            require(ok, "payout failed");
        }
        emit PayoutDistributed(recallId, distributed, holders.length);
        // TODO: integer-division dust (pot - distributed) is left unassigned here;
        //       sweep it to a treasury or the last holder in the implementation phase.
    }

    receive() external payable {}
}
