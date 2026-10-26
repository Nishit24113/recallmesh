// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Types
 * @notice Shared enums and structs for the RecallMesh system. Keeping these in one
 *         file lets every contract and interface agree on the same data model
 *         (the provenance DAG, actor roles, and recall lifecycle).
 */

/// @notice Role of a participant in the supply chain. `None` = not registered.
enum Role {
    None,
    Producer,
    Supplier,
    Processor,
    Distributor,
    Retailer,
    Regulator // accredited lab / regulator authorised to trigger recalls
}

/// @notice Lifecycle status of a lot (an ERC-1155 token in LotRegistry).
enum LotStatus {
    Active,      // freely transferable
    Quarantined, // frozen by a recall; cannot be transferred
    Recalled     // the defect-root lot that triggered a recall
}

/// @notice Lifecycle status of a recall event in RecallEngine.
enum RecallState {
    None,
    Initiated, // affected set computed + quarantined, bond slashed into escrow
    Disputed,  // an accused actor has opened a challenge
    Finalized  // challenge window closed, pro-rata payout distributed
}

/// @notice A production lot and its position in the provenance DAG.
/// @dev `parents` is the on-chain adjacency list that forms the DAG; a child lot
///      lists the parent lots consumed to make it (cf. Westerkamp et al., 2018).
struct Lot {
    uint256 id;
    address producer;      // who registered the lot
    address custodian;     // current holder of custody
    LotStatus status;
    uint256[] parents;     // parent lot ids consumed to create this lot
    string metadataURI;    // off-chain pointer (e.g. IPFS CID) to certificates
    uint256 createdAt;
}

/// @notice A recall event and its outcome.
struct Recall {
    uint256 id;
    uint256 rootLotId;     // the defect-root lot
    address atFaultActor;  // actor slashed for the defect (by lineage position)
    RecallState state;
    uint256 initiatedAt;
    uint256 slashed;       // amount moved into escrow for downstream payout
}
