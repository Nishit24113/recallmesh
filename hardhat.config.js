require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/**
 * Hardhat configuration for RecallMesh.
 * - Local development/tests run on the built-in `hardhat` network.
 * - Polygon Amoy testnet is configured via environment variables:
 *     AMOY_RPC_URL  (e.g. an Alchemy/Infura Amoy endpoint)
 *     PRIVATE_KEY   (deployer key; never commit this)
 */
const { AMOY_RPC_URL, PRIVATE_KEY } = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // OpenZeppelin v5.1+ uses the `mcopy` opcode; target Cancun (supported by
      // local Hardhat and Polygon Amoy).
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {},
    localhost: { url: "http://127.0.0.1:8545" },
    amoy: {
      url: AMOY_RPC_URL || "",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 80002,
    },
  },
};
