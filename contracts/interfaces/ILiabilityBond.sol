// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ILiabilityBond
 * @notice Holds each actor's staked collateral. Producing a lot locks part of the
 *         producer's bond, sized to the lot's quantity (throughput), for a liability
 *         period. On a recall the RecallEngine slashes the root lot's lock into a
 *         per-recall escrow and later pays it pro-rata to downstream holders (or
 *         refunds it if a dispute overturns the attribution). Only the LotRegistry may
 *         lock and only the RecallEngine may slash or pay, so custody is neutral.
 */
interface ILiabilityBond {
    event BondStaked(address indexed actor, uint256 amount);
    event BondWithdrawn(address indexed actor, uint256 amount);
    event BondLocked(address indexed actor, uint256 indexed lotId, uint256 amount, uint256 unlockAt);
    event BondReleased(address indexed actor, uint256 indexed lotId, uint256 amount);
    event BondSlashed(address indexed actor, uint256 amount, uint256 indexed recallId);
    event BondRefunded(address indexed actor, uint256 amount, uint256 indexed recallId);
    event PayoutDistributed(uint256 indexed recallId, uint256 totalAmount, uint256 recipients);
    event ClaimPaid(uint256 indexed recallId, address indexed to, uint256 amount);
    event PayoutCredited(uint256 indexed recallId, address indexed to, uint256 amount);
    event ClaimableWithdrawn(address indexed to, uint256 amount);

    /// @notice Stake (increase) the caller's free liability bond.
    function stakeBond() external payable;

    /// @notice Withdraw free (unlocked, non-escrowed) bond back to the caller.
    function withdrawBond(uint256 amount) external;

    /// @notice Free (withdrawable) bond balance of `actor`.
    function bondOf(address actor) external view returns (uint256);

    /// @notice Bond of `actor` currently locked against lots it produced.
    function lockedOf(address actor) external view returns (uint256);

    /// @notice Lock record of a lot: who posted it, original size, what is left, unlock time.
    function lotLock(uint256 lotId)
        external
        view
        returns (address owner, uint256 size, uint256 remaining, uint256 unlockAt);

    /// @notice Lock `bondPerUnit * quantity` of `actor`'s free bond against `lotId`.
    ///         Restricted to the LotRegistry (called from createLot).
    function lockForLot(address actor, uint256 lotId, uint256 quantity) external;

    /// @notice Return a lot's remaining lock to its producer's free bond once the
    ///         liability period has elapsed. Callable by anyone.
    function releaseLot(uint256 lotId) external;

    /// @notice Slash the bond posted for `lotId` (falling back to `actor`'s free bond
    ///         if the lock was already released) into escrow for `recallId`.
    /// @return slashed the amount actually moved to escrow.
    function slashForLot(address actor, uint256 lotId, uint256 recallId) external returns (uint256 slashed);

    /// @notice Distribute a recall's escrow pro-rata to downstream holders. Holders whose
    ///         address rejects ETH are credited instead (see `withdrawClaimable`).
    /// @param holders downstream holders of quarantined lots (computed by the RecallEngine)
    /// @param weights quarantined quantity held per entry
    function distributePayout(uint256 recallId, address[] calldata holders, uint256[] calldata weights)
        external;

    /// @notice Return a recall's escrow to the accused actor's free bond when a dispute
    ///         overturns the attribution. Restricted to the RecallEngine.
    function refundEscrow(uint256 recallId, address to) external returns (uint256 amount);

    /// @notice Pull-based payout: send `amount` from a recall's escrow to a single holder
    ///         (used by the Merkle claim path). Restricted to the RecallEngine.
    function payFromEscrow(uint256 recallId, address to, uint256 amount) external;

    /// @notice Escrow still held for a recall.
    function escrowOf(uint256 recallId) external view returns (uint256);

    /// @notice Payouts credited to `holder` because a direct transfer failed.
    function claimableOf(address holder) external view returns (uint256);

    /// @notice Withdraw the caller's credited payouts.
    function withdrawClaimable() external;
}
