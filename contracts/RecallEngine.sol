// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IRecallEngine} from "./interfaces/IRecallEngine.sol";
import {ILotRegistry} from "./interfaces/ILotRegistry.sol";
import {ILiabilityBond} from "./interfaces/ILiabilityBond.sol";
import {IDisputeModule} from "./interfaces/IDisputeModule.sol";
import {IActorRegistry} from "./interfaces/IActorRegistry.sol";
import {Recall, RecallState, LotStatus} from "./interfaces/Types.sol";

/**
 * @title RecallEngine
 * @notice The heart of RecallMesh: it ties liability to provenance-graph topology.
 *         Given an EIP-712 recall signed by the authorised oracle (regulator/lab),
 *         it (1) verifies the signature, (2) computes the affected descendant set
 *         over the DAG and quarantines those lots, (3) slashes the at-fault actor's
 *         bond into escrow, and (4) opens a dispute window. On finalisation it pays
 *         downstream holders pro-rata.
 * @dev Draft: `holders`/`weights` for payout are computed off-chain from the
 *      LotsQuarantined event + ERC-1155 balances and passed to finalizeRecall;
 *      a dispute that overturns the attribution should refund instead of pay out
 *      (marked TODO). Bond-sizing (`slashAmount`) is a placeholder pending the
 *      game-theoretic analysis in the report.
 */
contract RecallEngine is IRecallEngine, EIP712, Ownable {
    ILotRegistry public lots;
    ILiabilityBond public bond;
    IDisputeModule public disputes;
    IActorRegistry public actors;

    address public oracle;                 // authorised regulator/lab signer
    uint256 public challengeWindow = 3 days;
    uint256 public slashAmount = 1 ether;  // TODO: parameterise bond sizing (see report)

    uint256 private _nextRecallId = 1;
    mapping(uint256 => Recall) private _recalls;

    /// @dev EIP-712 typed-data hash of a recall authorisation.
    bytes32 private constant RECALL_TYPEHASH =
        keccak256("Recall(uint256 rootLotId,address atFaultActor,uint256 maxNodes)");

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

    /// @inheritdoc IRecallEngine
    function initiateRecall(
        uint256 rootLotId,
        address atFaultActor,
        uint256 maxNodes,
        bytes calldata oracleSig
    ) external returns (uint256 recallId) {
        // 1. Verify the recall was authorised by the trusted oracle (EIP-712).
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(RECALL_TYPEHASH, rootLotId, atFaultActor, maxNodes))
        );
        require(ECDSA.recover(digest, oracleSig) == oracle, "bad oracle sig");

        recallId = _nextRecallId++;
        _recalls[recallId] = Recall({
            id: recallId,
            rootLotId: rootLotId,
            atFaultActor: atFaultActor,
            state: RecallState.Initiated,
            initiatedAt: block.timestamp,
            slashed: 0
        });

        // 2. Compute the affected descendant set over the provenance DAG and quarantine it.
        lots.setStatus(rootLotId, LotStatus.Recalled);
        uint256[] memory affected = lots.affectedDescendants(rootLotId, maxNodes);
        for (uint256 i = 0; i < affected.length; i++) {
            lots.setStatus(affected[i], LotStatus.Quarantined);
        }
        emit LotsQuarantined(recallId, affected.length);

        // 3. Slash the at-fault actor's bond into escrow for downstream payout.
        uint256 slashed = bond.slashAndEscrow(atFaultActor, slashAmount, recallId);
        _recalls[recallId].slashed = slashed;

        // 4. Open the challenge window before settlement is final.
        disputes.openDispute(recallId, atFaultActor, challengeWindow);

        emit RecallInitiated(recallId, rootLotId, atFaultActor);
    }

    /// @inheritdoc IRecallEngine
    function finalizeRecall(
        uint256 recallId,
        address[] calldata holders,
        uint256[] calldata weights
    ) external {
        Recall storage r = _recalls[recallId];
        require(r.state == RecallState.Initiated, "bad state");
        require(disputes.isResolved(recallId), "dispute unresolved");

        if (disputes.isUpheld(recallId)) {
            // Attribution stands: pay the slashed collateral to downstream holders.
            bond.distributePayout(recallId, holders, weights);
        } else {
            // Attribution overturned on dispute: refund the slashed bond to the accused.
            bond.refundEscrow(recallId, r.atFaultActor);
        }
        r.state = RecallState.Finalized;
        emit RecallFinalized(recallId, r.slashed);
    }

    /// @inheritdoc IRecallEngine
    function getRecall(uint256 recallId) external view returns (Recall memory) {
        return _recalls[recallId];
    }
}
