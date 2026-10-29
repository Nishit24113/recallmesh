// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ILiabilityBond
 * @notice Holds each actor's staked collateral and performs slashing + pro-rata
 *         payout on a recall. Only the RecallEngine may slash or distribute, so
 *         custody of funds is neutral with respect to the (adversarial) parties.
 */
interface ILiabilityBond {
    event BondStaked(address indexed actor, uint256 amount);
    event BondWithdrawn(address indexed actor, uint256 amount);
    event BondSlashed(address indexed actor, uint256 amount, uint256 indexed recallId);
    event BondRefunded(address indexed actor, uint256 amount, uint256 indexed recallId);
    event PayoutDistributed(uint256 indexed recallId, uint256 totalAmount, uint256 recipients);

    /// @notice Stake (increase) the caller's liability bond.
    function stakeBond() external payable;

    /// @notice Withdraw free (non-escrowed) bond back to the caller.
    function withdrawBond(uint256 amount) external;

    /// @notice Free bond balance of `actor`.
    function bondOf(address actor) external view returns (uint256);

    /// @notice Slash up to `amount` from `actor` and hold it in escrow for `recallId`.
    /// @return slashed the amount actually moved to escrow (<= actor's bond).
    function slashAndEscrow(address actor, uint256 amount, uint256 recallId)
        external
        returns (uint256 slashed);

    /// @notice Distribute a recall's escrow pro-rata to downstream holders.
    /// @param holders downstream holders of quarantined lots
    /// @param weights relative weights (e.g. quarantined quantity held) per holder
    function distributePayout(uint256 recallId, address[] calldata holders, uint256[] calldata weights)
        external;

    /// @notice Return a recall's escrow to the (wrongly) accused actor's bond when a
    ///         dispute overturns the attribution. Restricted to the RecallEngine.
    function refundEscrow(uint256 recallId, address to) external returns (uint256 amount);
}
