// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IDisputeModule
 * @notice UMA-style challenge window. After a recall slashes an actor, that actor
 *         may contest the attribution within a time window before settlement is
 *         finalised, so slashing is never unilateral.
 */
interface IDisputeModule {
    event DisputeOpened(uint256 indexed recallId, address indexed accused, uint256 deadline);
    event ChallengeSubmitted(uint256 indexed recallId, address indexed accused, string evidenceURI);
    event DisputeResolved(uint256 indexed recallId, bool upheld);

    /// @notice Open a challenge window for a recall. Restricted to the RecallEngine.
    function openDispute(uint256 recallId, address accused, uint256 challengeWindow) external;

    /// @notice Accused actor submits evidence (IPFS CID) within the window.
    function submitChallenge(uint256 recallId, string calldata evidenceURI) external;

    /// @notice Arbiter resolves the dispute. `upheld` = the recall attribution stands.
    function resolveDispute(uint256 recallId, bool upheld) external;

    /// @notice True once the dispute for `recallId` has been resolved (or window passed).
    function isResolved(uint256 recallId) external view returns (bool);
}
