// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ILotRegistry} from "./interfaces/ILotRegistry.sol";
import {IActorRegistry} from "./interfaces/IActorRegistry.sol";
import {Lot, LotStatus} from "./interfaces/Types.sol";

/**
 * @title LotRegistry
 * @notice The provenance DAG as ERC-1155 tokens. Creating a lot records the parent
 *         lots it was made from (inbound edges) and, for traversal, the child edges
 *         on each parent. The RecallEngine calls `affectedDescendants` to compute,
 *         from a recalled root, the downstream set to quarantine, then `setStatus`
 *         to freeze them.
 * @dev Draft: `affectedDescendants` is a bounded BFS (cap = maxNodes). It is O(n^2)
 *      in the result size because a view function cannot use a storage `visited`
 *      set; this is acceptable for demo-sized graphs. See docs/architecture.md for
 *      the planned Merkle-membership path for large graphs.
 */
contract LotRegistry is ILotRegistry, ERC1155, Ownable {
    IActorRegistry public actors;
    address public recallEngine;

    uint256 private _nextId = 1;
    mapping(uint256 => Lot) private _lots;
    mapping(uint256 => uint256[]) private _children; // DAG child edges (parent => children)

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

    /// @inheritdoc ILotRegistry
    function createLot(uint256[] calldata parents, uint256 amount, string calldata metadataURI)
        external
        returns (uint256 lotId)
    {
        require(actors.isActive(msg.sender), "actor not active");
        lotId = _nextId++;

        // Validate each parent exists and record the child edge (this builds the DAG).
        for (uint256 i = 0; i < parents.length; i++) {
            require(parents[i] < lotId && _lots[parents[i]].id != 0, "bad parent");
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
        _mint(msg.sender, lotId, amount, "");
        emit LotCreated(lotId, msg.sender, parents);
    }

    /// @inheritdoc ILotRegistry
    function transferCustody(uint256 lotId, address to, uint256 amount) external {
        Lot storage lot = _lots[lotId];
        require(lot.id != 0, "no lot");
        require(lot.status == LotStatus.Active, "lot frozen"); // quarantined lots cannot move
        require(actors.isActive(to), "recipient inactive");
        safeTransferFrom(msg.sender, to, lotId, amount, "");
        lot.custodian = to;
        emit CustodyTransferred(lotId, msg.sender, to);
    }

    /// @inheritdoc ILotRegistry
    function getLot(uint256 lotId) external view returns (Lot memory) {
        return _lots[lotId];
    }

    /// @inheritdoc ILotRegistry
    function parentsOf(uint256 lotId) external view returns (uint256[] memory) {
        return _lots[lotId].parents;
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
