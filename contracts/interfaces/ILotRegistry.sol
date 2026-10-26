// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Lot, LotStatus} from "./Types.sol";

/**
 * @title ILotRegistry
 * @notice The provenance DAG. Each lot is an ERC-1155 token that records the
 *         parent lots it was made from, forming a directed acyclic graph. The
 *         RecallEngine uses `affectedDescendants` to compute, from a recalled
 *         root lot, the exact set of downstream lots to quarantine.
 */
interface ILotRegistry {
    event LotCreated(uint256 indexed lotId, address indexed producer, uint256[] parents);
    event CustodyTransferred(uint256 indexed lotId, address indexed from, address indexed to);
    event LotStatusChanged(uint256 indexed lotId, LotStatus status);

    /// @notice Create (mint) a new lot referencing the parent lots it consumes.
    /// @param parents    parent lot ids (empty for a raw/origin lot)
    /// @param amount     ERC-1155 quantity minted to the producer
    /// @param metadataURI off-chain pointer (IPFS CID) to certificates
    /// @return lotId the new lot's token id
    function createLot(uint256[] calldata parents, uint256 amount, string calldata metadataURI)
        external
        returns (uint256 lotId);

    /// @notice Transfer custody of a lot to another registered actor.
    function transferCustody(uint256 lotId, address to, uint256 amount) external;

    /// @notice Full lot record (producer, custodian, status, parents, metadata).
    function getLot(uint256 lotId) external view returns (Lot memory);

    /// @notice Parent lot ids of `lotId` (its inbound DAG edges).
    function parentsOf(uint256 lotId) external view returns (uint256[] memory);

    /// @notice Set a lot's status. Restricted to the RecallEngine (quarantine/recall).
    function setStatus(uint256 lotId, LotStatus status) external;

    /// @notice Bounded transitive-closure traversal: all descendant lots reachable
    ///         from `rootLotId`, capped at `maxNodes` to bound gas.
    /// @dev The cap is a deliberate draft-stage safeguard; see docs/architecture.md
    ///      for the planned Merkle-membership path for large graphs.
    function affectedDescendants(uint256 rootLotId, uint256 maxNodes)
        external
        view
        returns (uint256[] memory);
}
