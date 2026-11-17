// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ILotRegistry} from "./interfaces/ILotRegistry.sol";
import {IActorRegistry} from "./interfaces/IActorRegistry.sol";
import {ILiabilityBond} from "./interfaces/ILiabilityBond.sol";
import {Lot, LotStatus} from "./interfaces/Types.sol";

/**
 * @title LotRegistry
 * @notice The provenance DAG as ERC-1155 tokens. Creating a lot records the parent
 *         lots it was made from (inbound edges) and, for traversal, the child edges
 *         on each parent. The RecallEngine calls `affectedDescendants` to compute,
 *         from a recalled root, the downstream set to quarantine, then `setStatus`
 *         to freeze them.
 *
 *  - **Freeze (ERC-3643-style).** Every token movement goes through `_update`, which
 *    rejects transfers of non-Active lots and transfers to unregistered addresses, so the
 *    freeze cannot be bypassed via the inherited `safeTransferFrom`/`safeBatchTransferFrom`.
 *  - **Holder tracking.** `_update` also records every address that has held a lot, so
 *    the RecallEngine can compute pro-rata payouts on-chain instead of trusting a caller.
 *  - **Bond lock.** `createLot` locks the producer's bond in proportion to the quantity.
 *
 * @dev `affectedDescendants` is a bounded BFS (cap = maxNodes), O(n^2) in the result size
 *      because a view cannot keep a storage `visited` set. Large graphs use the
 *      Merkle-anchored recall path in RecallEngine instead.
 */
contract LotRegistry is ILotRegistry, ERC1155, Ownable {
    IActorRegistry public actors;
    ILiabilityBond public bond;
    address public recallEngine;

    uint256 private _nextId = 1;
    mapping(uint256 => Lot) private _lots;
    mapping(uint256 => uint256[]) private _children; // DAG child edges (parent => children)
    mapping(uint256 => address[]) private _holders;  // lotId => every address that held it
    mapping(uint256 => mapping(address => bool)) private _isHolder;

    modifier onlyRecallEngine() {
        require(msg.sender == recallEngine, "only RecallEngine");
        _;
    }

    constructor(address actorsAddr, address owner_) ERC1155("") Ownable(owner_) {
        actors = IActorRegistry(actorsAddr);
    }

    /// @notice Wire the RecallEngine address (set once after deployment).
    function setRecallEngine(address engine) external onlyOwner {
        recallEngine = engine;
    }

    /// @notice Wire the LiabilityBond that backs lot creation (set once after deployment).
    function setBond(address bond_) external onlyOwner {
        bond = ILiabilityBond(bond_);
    }

    /// @inheritdoc ILotRegistry
    function createLot(uint256[] calldata parents, uint256 amount, string calldata metadataURI)
        external
        returns (uint256 lotId)
    {
        require(actors.isActive(msg.sender), "actor not active");
        require(address(bond) != address(0), "bond not set");
        require(amount > 0, "zero amount");
        lotId = _nextId++;

        // Validate each parent exists and is not frozen, and record the child edge
        // (this builds the DAG). Building on recalled/quarantined stock is rejected.
        for (uint256 i = 0; i < parents.length; i++) {
            require(parents[i] < lotId && _lots[parents[i]].id != 0, "bad parent");
            require(_lots[parents[i]].status == LotStatus.Active, "parent frozen");
            _children[parents[i]].push(lotId);
        }

        _lots[lotId] = Lot({
            id: lotId,
            producer: msg.sender,
            custodian: msg.sender,
            status: LotStatus.Active,
            parents: parents,
            metadataURI: metadataURI,
            createdAt: block.timestamp
        });

        // Lock collateral sized to the lot's quantity (reverts if the bond is too small).
        bond.lockForLot(msg.sender, lotId, amount);

        _mint(msg.sender, lotId, amount, "");
        emit LotCreated(lotId, msg.sender, parents);
    }

    /// @inheritdoc ILotRegistry
    function transferCustody(uint256 lotId, address to, uint256 amount) external {
        require(_lots[lotId].id != 0, "no lot");
        // Freeze + recipient checks and the custodian update live in `_update`.
        safeTransferFrom(msg.sender, to, lotId, amount, "");
        emit CustodyTransferred(lotId, msg.sender, to);
    }

    /// @dev Single choke point for every mint/transfer: enforces the quarantine freeze and
    ///      the registered-recipient rule, and maintains custodian + holder tracking.
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override
    {
        if (from != address(0)) {
            require(to == address(0) || actors.isActive(to), "recipient inactive");
            for (uint256 i = 0; i < ids.length; i++) {
                require(_lots[ids[i]].status == LotStatus.Active, "lot frozen");
            }
        }

        super._update(from, to, ids, values);

        if (to != address(0)) {
            for (uint256 i = 0; i < ids.length; i++) {
                uint256 id = ids[i];
                if (!_isHolder[id][to]) {
                    _isHolder[id][to] = true;
                    _holders[id].push(to);
                }
                if (from != address(0)) _lots[id].custodian = to;
            }
        }
    }

    /// @inheritdoc ILotRegistry
    function getLot(uint256 lotId) external view returns (Lot memory) {
        return _lots[lotId];
    }

    /// @inheritdoc ILotRegistry
    function statusOf(uint256 lotId) external view returns (LotStatus) {
        return _lots[lotId].status;
    }

    /// @inheritdoc ILotRegistry
    function producerOf(uint256 lotId) external view returns (address) {
        return _lots[lotId].producer;
    }

    /// @inheritdoc ILotRegistry
    function parentsOf(uint256 lotId) external view returns (uint256[] memory) {
        return _lots[lotId].parents;
    }

    /// @inheritdoc ILotRegistry
    function holdersOf(uint256 lotId) external view returns (address[] memory) {
        return _holders[lotId];
    }

    /// @inheritdoc ILotRegistry
    function holdingsOf(uint256 lotId)
        external
        view
        returns (address[] memory holders, uint256[] memory balances)
    {
        holders = _holders[lotId];
        balances = new uint256[](holders.length);
        for (uint256 i = 0; i < holders.length; i++) {
            balances[i] = balanceOf(holders[i], lotId);
        }
    }

    /// @notice Number of lots created so far (lot ids are 1..lotCount).
    function lotCount() external view returns (uint256) {
        return _nextId - 1;
    }

    /// @inheritdoc ILotRegistry
    function setStatus(uint256 lotId, LotStatus status) external onlyRecallEngine {
        require(_lots[lotId].id != 0, "no lot");
        _lots[lotId].status = status;
        emit LotStatusChanged(lotId, status);
    }

    /// @inheritdoc ILotRegistry
    function affectedDescendants(uint256 rootLotId, uint256 maxNodes)
        external
        view
        returns (uint256[] memory)
    {
        require(_lots[rootLotId].id != 0, "no lot");
        uint256[] memory result = new uint256[](maxNodes);
        uint256[] memory queue = new uint256[](maxNodes);
        uint256 count;
        uint256 qHead;
        uint256 qTail;

        // Seed the queue with the root's direct children.
        uint256[] storage rootKids = _children[rootLotId];
        for (uint256 i = 0; i < rootKids.length && qTail < maxNodes; i++) {
            queue[qTail++] = rootKids[i];
        }

        // BFS over child edges; dedupe against `result` (a DAG node is reachable by
        // multiple paths) and stop at the maxNodes cap.
        while (qHead < qTail && count < maxNodes) {
            uint256 node = queue[qHead++];

            bool seen;
            for (uint256 j = 0; j < count; j++) {
                if (result[j] == node) {
                    seen = true;
                    break;
                }
            }
            if (seen) continue;

            result[count++] = node;

            uint256[] storage kids = _children[node];
            for (uint256 k = 0; k < kids.length && qTail < maxNodes; k++) {
                queue[qTail++] = kids[k];
            }
        }

        // Shrink to the actual count.
        uint256[] memory out = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            out[i] = result[i];
        }
        return out;
    }
}
