// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Recall} from "./Types.sol";

/**
 * @title IRecallEngine
 * @notice Orchestrates a recall: verifies an authorised oracle's signed trigger,
 *         derives the at-fault actor from the provenance graph (the producer of the
 *         recalled root lot), computes the affected descendant set, quarantines those
 *         lots, slashes the bond posted for the root lot into escrow, opens a dispute
 *         window, and (on finalisation) pays downstream holders pro-rata. This is the
 *         contract that ties liability to graph topology.
 */
interface IRecallEngine {
    event RecallInitiated(
        uint256 indexed recallId,
        uint256 indexed rootLotId,
        address indexed atFaultActor,
        string certificateCID
    );
    event LotsQuarantined(uint256 indexed recallId, uint256 count);
    event RecallFinalized(uint256 indexed recallId, uint256 slashedAmount);

    /// @notice Initiate a recall from an EIP-712 signature by the authorised oracle.
    ///         The at-fault actor is not a parameter: it is the root lot's producer.
    /// @param rootLotId      the defect-root lot
    /// @param maxNodes       traversal cap passed to LotRegistry.affectedDescendants
    /// @param certificateCID IPFS CID of the lab certificate (bound into the signature)
    /// @param oracleSig      EIP-712 signature over (rootLotId, maxNodes, certificateCID)
    /// @return recallId the new recall's id
    function initiateRecall(
        uint256 rootLotId,
        uint256 maxNodes,
        string calldata certificateCID,
        bytes calldata oracleSig
    ) external returns (uint256 recallId);

    /// @notice Finalise a recall once its dispute is resolved. If the attribution stands
    ///         (eager mode) the escrow is paid to the on-chain-computed downstream holders;
    ///         if it was overturned the escrow is refunded to the accused. Permissionless:
    ///         the caller cannot influence who is paid.
    function finalizeRecall(uint256 recallId) external;

    /// @notice Full recall record.
    function getRecall(uint256 recallId) external view returns (Recall memory);

    /// @notice Affected lots recorded for an eager-mode recall.
    function affectedOf(uint256 recallId) external view returns (uint256[] memory);
}
