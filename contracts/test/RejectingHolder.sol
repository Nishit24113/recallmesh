// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

/// @dev Test-only: a lot holder that accepts ERC-1155 tokens but rejects ETH, used to
///      check that one rejecting payout recipient cannot block settlement for everyone.
contract RejectingHolder is ERC1155Holder {
    receive() external payable {
        revert("no ETH");
    }
}
