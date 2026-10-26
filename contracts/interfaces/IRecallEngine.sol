// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Recall} from "./Types.sol";

/**
 * @title IRecallEngine
 * @notice Orchestrates a recall: verifies an authorised oracle's signed trigger,
 *         computes the affected descendant set over the provenance DAG, quarantines
 *         those lots, slashes the at-fault actor's bond into escrow, opens a dispute
 *         window, and (on finalisation) pays downstream holders pro-rata. This is
 *         the contract that ties liability to graph topology.
 */
interface IRecallEngine {
    event RecallInitiated(uint256 indexed recallId, uint256 indexed rootLotId, address indexed atFaultActor);
    event LotsQuarantined(uint256 indexed recallId, uint256 count);
    event RecallFinalized(uint256 indexed recallId, uint256 slashedAmount);

    /// @notice Initiate a recall from an EIP-712 signature by the authorised oracle.
    /// @param rootLotId     the defect-root lot
    /// @param atFaultActor  actor to slash (determined by lineage position)
    /// @param maxNodes      traversal cap passed to LotRegistry.affectedDescendants
    /// @param oracleSig     EIP-712 signature over the recall parameters
    /// @return recallId the new recall's id
    function initiateRecall(
        uint256 rootLotId,
        address atFaultActor,
        uint256 maxNodes,
        bytes calldata oracleSig
    ) external returns (uint256 recallId);

    /// @notice Finalise a recall after its dispute window: pay downstream holders.
    function finalizeRecall(
        uint256 recallId,
        address[] calldata holders,
        uint256[] calldata weights
    ) external;

    /// @notice Full recall record.
    function getRecall(uint256 recallId) external view returns (Recall memory);
}
