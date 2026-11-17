// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IRecallEngine} from "./interfaces/IRecallEngine.sol";
import {ILotRegistry} from "./interfaces/ILotRegistry.sol";
import {ILiabilityBond} from "./interfaces/ILiabilityBond.sol";
import {IDisputeModule} from "./interfaces/IDisputeModule.sol";
import {IActorRegistry} from "./interfaces/IActorRegistry.sol";
import {Recall, RecallState, RecallMode, LotStatus} from "./interfaces/Types.sol";

/**
 * @title RecallEngine
 * @notice The heart of RecallMesh: it ties liability to provenance-graph topology.
 *         Given an EIP-712 recall signed by the authorised oracle (regulator/lab) that
 *         names a root lot and the IPFS CID of the lab certificate, it
 *         (1) verifies the signature,
 *         (2) derives the at-fault actor from the graph: the producer of the root lot,
 *         (3) computes the affected descendant set and quarantines it,
 *         (4) slashes the bond that producer locked for the root lot into escrow, and
 *         (5) opens a dispute window.
 *         Once the dispute resolves, `finalizeRecall` pays downstream holders pro-rata
 *         (amounts computed on-chain from ERC-1155 balances) or refunds the accused if
 *         the attribution was overturned.
 *
 *         Two modes:
 *         - Eager: on-chain BFS + quarantine loop (simple, for small graphs/demo).
 *         - Merkle: the oracle commits Merkle roots of the affected set and payout table;
 *           initiation is O(1) and quarantine/payout are permissionless O(log n) proofs.
 */
contract RecallEngine is IRecallEngine, EIP712, Ownable {
    ILotRegistry public lots;
    ILiabilityBond public bond;
    IDisputeModule public disputes;
    IActorRegistry public actors;

    address public oracle; // authorised regulator/lab signer
    uint256 public challengeWindow = 3 days;

    uint256 private _nextRecallId = 1;
    mapping(uint256 => Recall) private _recalls;
    // Eager mode: traversal cap used at initiation. The affected set is recomputed from the
    // DAG at finalize instead of stored (saves one SSTORE per lot): it cannot change in
    // between, because createLot rejects frozen parents and every affected lot is frozen.
    mapping(uint256 => uint256) private _maxNodes;

    /// @dev EIP-712 typed data for an eager (on-chain traversal) recall.
    bytes32 private constant RECALL_TYPEHASH =
        keccak256("Recall(uint256 rootLotId,uint256 maxNodes,string certificateCID)");

    /// @dev EIP-712 typed data for a Merkle-anchored recall.
    bytes32 private constant RECALL_MERKLE_TYPEHASH = keccak256(
        "RecallMerkle(uint256 rootLotId,bytes32 quarantineRoot,bytes32 payoutRoot,uint256 totalWeight,string certificateCID)"
    );

    mapping(uint256 => bytes32) private _quarantineRoot;    // recallId => root of affected lot ids
    mapping(uint256 => bytes32) private _payoutRoot;        // recallId => root of (lotId,holder,weight)
    mapping(uint256 => uint256) private _payoutTotalWeight; // recallId => sum of weights
    mapping(uint256 => mapping(uint256 => bool)) private _lotQuarantined; // recallId => lotId => done
    mapping(uint256 => mapping(bytes32 => bool)) private _claimed;        // recallId => leafKey => claimed

    event LotQuarantinedMerkle(uint256 indexed recallId, uint256 indexed lotId);
    event PayoutClaimed(uint256 indexed recallId, uint256 indexed lotId, address indexed holder, uint256 amount);

    constructor(
        address lots_,
        address bond_,
        address disputes_,
        address actors_,
        address oracle_,
        address owner_
    ) EIP712("RecallMesh", "1") Ownable(owner_) {
        lots = ILotRegistry(lots_);
        bond = ILiabilityBond(bond_);
        disputes = IDisputeModule(disputes_);
        actors = IActorRegistry(actors_);
        oracle = oracle_;
    }

    function setOracle(address oracle_) external onlyOwner {
        oracle = oracle_;
    }

    function setChallengeWindow(uint256 window) external onlyOwner {
        challengeWindow = window;
    }

    // ------------------------------------------------------------------
    //  Eager recall path
    // ------------------------------------------------------------------

    /// @inheritdoc IRecallEngine
    function initiateRecall(
        uint256 rootLotId,
        uint256 maxNodes,
        string calldata certificateCID,
        bytes calldata oracleSig
    ) external returns (uint256 recallId) {
        // 1. Verify the recall was authorised by the trusted oracle (EIP-712).
        bytes32 structHash = keccak256(
            abi.encode(RECALL_TYPEHASH, rootLotId, maxNodes, keccak256(bytes(certificateCID)))
        );
        _verifyOracle(structHash, oracleSig);

        // 2-4. Attribute by graph position, mark the root recalled, slash, open dispute.
        recallId = _open(rootLotId, RecallMode.Eager, certificateCID);

        // 3. Compute the affected descendant set over the DAG and quarantine it.
        uint256[] memory affected = lots.affectedDescendants(rootLotId, maxNodes);
        for (uint256 i = 0; i < affected.length; i++) {
            if (lots.statusOf(affected[i]) != LotStatus.Recalled) {
                lots.setStatus(affected[i], LotStatus.Quarantined);
            }
        }
        _maxNodes[recallId] = maxNodes;
        emit LotsQuarantined(recallId, affected.length);
    }

    /// @inheritdoc IRecallEngine
    function finalizeRecall(uint256 recallId) external {
        Recall storage r = _recalls[recallId];
        require(r.state == RecallState.Initiated, "bad state");
        require(disputes.isResolved(recallId), "dispute unresolved");

        if (!disputes.isUpheld(recallId)) {
            // Attribution overturned on dispute: refund the slashed bond to the accused.
            bond.refundEscrow(recallId, r.atFaultActor);
        } else {
            // Merkle recalls settle through per-holder claimPayout proofs.
            require(r.mode == RecallMode.Eager, "use claimPayout");
            (address[] memory holders, uint256[] memory weights) = _eagerPayouts(r);
            if (holders.length == 0) {
                // No innocent downstream holder was harmed; return the collateral.
                bond.refundEscrow(recallId, r.atFaultActor);
            } else {
                bond.distributePayout(recallId, holders, weights);
            }
        }
        r.state = RecallState.Finalized;
        emit RecallFinalized(recallId, r.slashed);
    }

    /// @dev Pro-rata table for an eager recall, computed on-chain: one entry per
    ///      (affected lot, holder) with a non-zero balance, excluding the at-fault actor.
    function _eagerPayouts(Recall storage r)
        internal
        view
        returns (address[] memory holders, uint256[] memory weights)
    {
        address atFault = r.atFaultActor;
        uint256[] memory affected = lots.affectedDescendants(r.rootLotId, _maxNodes[r.id]);
        address[][] memory hs = new address[][](affected.length);
        uint256[][] memory bs = new uint256[][](affected.length);

        uint256 n;
        for (uint256 i = 0; i < affected.length; i++) {
            (hs[i], bs[i]) = lots.holdingsOf(affected[i]);
            for (uint256 j = 0; j < hs[i].length; j++) {
                if (bs[i][j] > 0 && hs[i][j] != atFault) n++;
            }
        }

        holders = new address[](n);
        weights = new uint256[](n);
        uint256 k;
        for (uint256 i = 0; i < affected.length; i++) {
            for (uint256 j = 0; j < hs[i].length; j++) {
                if (bs[i][j] > 0 && hs[i][j] != atFault) {
                    holders[k] = hs[i][j];
                    weights[k] = bs[i][j];
                    k++;
                }
            }
        }
    }

    // ------------------------------------------------------------------
    //  Scalable Merkle-anchored recall path
    // ------------------------------------------------------------------

    /// @notice Initiate a recall by committing Merkle roots (computed off-chain) of the
    ///         affected-descendant set and the pro-rata payout table. This is O(1): it does
    ///         no on-chain graph traversal and no per-lot loop, so its gas is independent of
    ///         the size of the affected set.
    function initiateRecallMerkle(
        uint256 rootLotId,
        bytes32 quarantineRoot_,
        bytes32 payoutRoot_,
        uint256 totalWeight_,
        string calldata certificateCID,
        bytes calldata oracleSig
    ) external returns (uint256 recallId) {
        bytes32 structHash = keccak256(abi.encode(
            RECALL_MERKLE_TYPEHASH,
            rootLotId,
            quarantineRoot_,
            payoutRoot_,
            totalWeight_,
            keccak256(bytes(certificateCID))
        ));
        _verifyOracle(structHash, oracleSig);
        require(totalWeight_ > 0, "no weight");

        recallId = _open(rootLotId, RecallMode.Merkle, certificateCID); // descendants: lazily, by proof
        _quarantineRoot[recallId] = quarantineRoot_;
        _payoutRoot[recallId] = payoutRoot_;
        _payoutTotalWeight[recallId] = totalWeight_;
    }

    /// @notice Quarantine one affected lot by proving its membership in the recall's
    ///         affected-set Merkle root. Permissionless and O(log n) per lot.
    function quarantineWithProof(uint256 recallId, uint256 lotId, bytes32[] calldata proof) external {
        require(_recalls[recallId].mode == RecallMode.Merkle && _recalls[recallId].id != 0, "not a merkle recall");
        require(!_lotQuarantined[recallId][lotId], "already quarantined");
        // leaf hashing matches OpenZeppelin StandardMerkleTree (double keccak of the ABI-encoded tuple)
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(lotId))));
        require(MerkleProof.verify(proof, _quarantineRoot[recallId], leaf), "bad proof");
        _lotQuarantined[recallId][lotId] = true;
        if (lots.statusOf(lotId) != LotStatus.Recalled) {
            lots.setStatus(lotId, LotStatus.Quarantined);
        }
        emit LotQuarantinedMerkle(recallId, lotId);
    }

    /// @notice Pull-based pro-rata payout: anyone may submit a holder's (lotId, holder,
    ///         weight) entry with its proof; the share always goes to `holder`. O(log n).
    function claimPayout(
        uint256 recallId,
        uint256 lotId,
        address holder,
        uint256 weight,
        bytes32[] calldata proof
    ) external {
        Recall storage r = _recalls[recallId];
        require(r.id != 0 && r.mode == RecallMode.Merkle, "not a merkle recall");
        require(disputes.isResolved(recallId), "dispute unresolved");
        require(disputes.isUpheld(recallId), "attribution overturned");
        bytes32 key = keccak256(abi.encode(lotId, holder, weight));
        require(!_claimed[recallId][key], "already claimed");
        bytes32 leaf = keccak256(bytes.concat(key));
        require(MerkleProof.verify(proof, _payoutRoot[recallId], leaf), "bad proof");
        _claimed[recallId][key] = true;
        uint256 share = (r.slashed * weight) / _payoutTotalWeight[recallId];
        if (share > 0) bond.payFromEscrow(recallId, holder, share);
        emit PayoutClaimed(recallId, lotId, holder, share);
    }

    /// @notice Whether a payout entry has already been claimed.
    function isClaimed(uint256 recallId, uint256 lotId, address holder, uint256 weight)
        external
        view
        returns (bool)
    {
        return _claimed[recallId][keccak256(abi.encode(lotId, holder, weight))];
    }

    /// @notice Committed Merkle roots + total weight for a Merkle-anchored recall.
    function recallRoots(uint256 recallId)
        external
        view
        returns (bytes32 quarantineRoot, bytes32 payoutRoot, uint256 totalWeight)
    {
        return (_quarantineRoot[recallId], _payoutRoot[recallId], _payoutTotalWeight[recallId]);
    }

    // ------------------------------------------------------------------
    //  Shared
    // ------------------------------------------------------------------

    /// @dev Common initiation: attribute fault by graph position (root lot's producer),
    ///      mark the root Recalled, slash the bond locked for it, and open the dispute.
    function _open(uint256 rootLotId, RecallMode mode, string calldata certificateCID)
        internal
        returns (uint256 recallId)
    {
        address atFault = lots.producerOf(rootLotId);
        require(atFault != address(0), "no lot");
        require(lots.statusOf(rootLotId) != LotStatus.Recalled, "already recalled");

        recallId = _nextRecallId++;
        lots.setStatus(rootLotId, LotStatus.Recalled);
        uint256 slashed = bond.slashForLot(atFault, rootLotId, recallId);

        _recalls[recallId] = Recall({
            id: recallId,
            rootLotId: rootLotId,
            atFaultActor: atFault,
            state: RecallState.Initiated,
            mode: mode,
            initiatedAt: block.timestamp,
            slashed: slashed,
            certificateCID: certificateCID
        });

        disputes.openDispute(recallId, atFault, challengeWindow);
        emit RecallInitiated(recallId, rootLotId, atFault, certificateCID);
    }

    function _verifyOracle(bytes32 structHash, bytes calldata sig) internal view {
        require(ECDSA.recover(_hashTypedDataV4(structHash), sig) == oracle, "bad oracle sig");
    }

    /// @inheritdoc IRecallEngine
    function getRecall(uint256 recallId) external view returns (Recall memory) {
        return _recalls[recallId];
    }

    /// @inheritdoc IRecallEngine
    function affectedOf(uint256 recallId) external view returns (uint256[] memory) {
        Recall storage r = _recalls[recallId];
        if (r.id == 0 || r.mode != RecallMode.Eager) return new uint256[](0);
        return lots.affectedDescendants(r.rootLotId, _maxNodes[recallId]);
    }

    /// @notice Number of recalls initiated so far (ids are 1..recallCount).
    function recallCount() external view returns (uint256) {
        return _nextRecallId - 1;
    }
}
