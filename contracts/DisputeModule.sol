// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IDisputeModule} from "./interfaces/IDisputeModule.sol";

/**
 * @title DisputeModule
 * @notice UMA-style challenge window. When a recall slashes an actor, the RecallEngine
 *         opens a dispute here; the accused may submit evidence within the window, and
 *         an arbiter resolves it. If the window elapses with no challenge, the recall
 *         is treated as auto-upheld so settlement can finalise.
 * @dev Draft: the arbiter is a single trusted role here; a production version could
 *      replace it with an optimistic-oracle vote or a committee.
 */
contract DisputeModule is IDisputeModule, Ownable {
    address public recallEngine;
    address public arbiter;

    struct Dispute {
        address accused;
        uint256 deadline;
        bool challenged;
        bool resolved;
        bool upheld;
    }

    mapping(uint256 => Dispute) private _disputes;

    modifier onlyRecallEngine() {
        require(msg.sender == recallEngine, "only RecallEngine");
        _;
    }

    constructor(address arbiter_, address owner_) Ownable(owner_) {
        arbiter = arbiter_;
    }

    function setRecallEngine(address engine) external onlyOwner {
        recallEngine = engine;
    }

    function setArbiter(address arbiter_) external onlyOwner {
        arbiter = arbiter_;
    }

    /// @inheritdoc IDisputeModule
    function openDispute(uint256 recallId, address accused, uint256 challengeWindow)
        external
        onlyRecallEngine
    {
        uint256 deadline = block.timestamp + challengeWindow;
        _disputes[recallId] = Dispute({
            accused: accused,
            deadline: deadline,
            challenged: false,
            resolved: false,
            upheld: false
        });
        emit DisputeOpened(recallId, accused, deadline);
    }

    /// @inheritdoc IDisputeModule
    function submitChallenge(uint256 recallId, string calldata evidenceURI) external {
        Dispute storage d = _disputes[recallId];
        require(msg.sender == d.accused, "not accused");
        require(block.timestamp <= d.deadline, "window closed");
        d.challenged = true;
        emit ChallengeSubmitted(recallId, msg.sender, evidenceURI);
    }

    /// @inheritdoc IDisputeModule
    function resolveDispute(uint256 recallId, bool upheld) external {
        require(msg.sender == arbiter, "only arbiter");
        Dispute storage d = _disputes[recallId];
        require(!d.resolved, "already resolved");
        d.resolved = true;
        d.upheld = upheld;
        emit DisputeResolved(recallId, upheld);
    }

    /// @inheritdoc IDisputeModule
    /// @dev Resolved if an arbiter ruled, OR the window elapsed with no challenge
    ///      (auto-upheld). A challenged-but-unresolved dispute stays open.
    function isResolved(uint256 recallId) external view returns (bool) {
        Dispute storage d = _disputes[recallId];
        if (d.resolved) return true;
        return d.deadline != 0 && block.timestamp > d.deadline && !d.challenged;
    }

    /// @inheritdoc IDisputeModule
    function isUpheld(uint256 recallId) external view returns (bool) {
        Dispute storage d = _disputes[recallId];
        if (d.resolved) return d.upheld;              // arbiter ruling
        return d.deadline != 0 && block.timestamp > d.deadline && !d.challenged; // auto-upheld
    }
}
