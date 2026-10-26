// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IActorRegistry} from "./interfaces/IActorRegistry.sol";
import {Role} from "./interfaces/Types.sol";

/**
 * @title ActorRegistry
 * @notice On-chain registry of supply-chain participants and their roles. An admin
 *         (the consortium operator) onboards actors; other contracts read this to
 *         gate actions (e.g. only active actors create/transfer lots; only a
 *         Regulator-signed message may authorise a recall).
 * @dev Draft: role management is intentionally simple; a production version would
 *      add per-role admins and off-boarding workflows.
 */
contract ActorRegistry is IActorRegistry, AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    struct ActorInfo {
        Role role;
        bool active;
        string name;
    }

    mapping(address => ActorInfo) private _actors;

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    /// @inheritdoc IActorRegistry
    function registerActor(address actor, Role role, string calldata name)
        external
        onlyRole(ADMIN_ROLE)
    {
        require(actor != address(0), "zero actor");
        require(role != Role.None, "invalid role");
        _actors[actor] = ActorInfo({role: role, active: true, name: name});
        emit ActorRegistered(actor, role, name);
    }

    /// @inheritdoc IActorRegistry
    function deactivateActor(address actor) external onlyRole(ADMIN_ROLE) {
        _actors[actor].active = false;
        emit ActorDeactivated(actor);
    }

    /// @inheritdoc IActorRegistry
    function roleOf(address actor) external view returns (Role) {
        return _actors[actor].role;
    }

    /// @inheritdoc IActorRegistry
    function isActive(address actor) external view returns (bool) {
        ActorInfo storage a = _actors[actor];
        return a.active && a.role != Role.None;
    }
}
