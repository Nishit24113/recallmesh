// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Role} from "./Types.sol";

/**
 * @title IActorRegistry
 * @notice Registry of supply-chain participants and their roles. Other contracts
 *         consult it to check that a caller is a known, active actor and what
 *         role they hold (e.g. only a Regulator may authorise a recall).
 */
interface IActorRegistry {
    event ActorRegistered(address indexed actor, Role role, string name);
    event ActorDeactivated(address indexed actor);

    /// @notice Register a participant with a role. Admin-gated.
    function registerActor(address actor, Role role, string calldata name) external;

    /// @notice Deactivate a participant (e.g. revoked / off-boarded).
    function deactivateActor(address actor) external;

    /// @notice Role held by `actor` (Role.None if unregistered).
    function roleOf(address actor) external view returns (Role);

    /// @notice True if `actor` is registered and active.
    function isActive(address actor) external view returns (bool);
}
