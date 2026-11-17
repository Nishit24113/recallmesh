/**
 * Deploys and wires the five RecallMesh contracts, then writes the addresses to
 *   - deployments/<network>.json   (used by seed.js and the oracle service)
 *   - ui/src/deployments.json      (used by the dApp)
 *
 *   npx hardhat run scripts/deploy.js --network localhost
 *   npx hardhat run scripts/deploy.js --network amoy
 *
 * Roles (env overrides):
 *   ORACLE_ADDRESS   lab/regulator signer. Default: address of ORACLE_PRIVATE_KEY if set, else
 *                    Hardhat account #1 locally (the oracle service's default key), else the
 *                    deployer (the oracle service then signs with PRIVATE_KEY).
 *   ARBITER_ADDRESS  dispute arbiter. Default: deployer.
 * Parameters:
 *   BOND_PER_UNIT (in ETH/POL; default 0.01 local, 0.0001 on testnets)
 *   LIABILITY_PERIOD_DAYS (default 30)
 *   CHALLENGE_WINDOW_SECONDS (default 3 days local; 15 minutes on testnets so a live demo
 *                             can auto-uphold without waiting days)
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deploySystem } = require("./lib/system.js");

const EXPLORERS = { 80002: "https://amoy.polygonscan.com" };
const PUBLIC_RPC = { 80002: "https://rpc-amoy.polygon.technology" };

async function main() {
  const { ethers, network } = hre;
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const isLocal = ["hardhat", "localhost"].includes(network.name);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const oracle =
    process.env.ORACLE_ADDRESS ||
    (process.env.ORACLE_PRIVATE_KEY && new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY).address) ||
    (isLocal ? signers[1].address : deployer.address);
  const arbiter = process.env.ARBITER_ADDRESS || deployer.address;
  const bondPerUnit = ethers.parseEther(process.env.BOND_PER_UNIT || (isLocal ? "0.01" : "0.0001"));
  const liabilityPeriod = Number(process.env.LIABILITY_PERIOD_DAYS || 30) * 24 * 60 * 60;
  const challengeWindow = Number(process.env.CHALLENGE_WINDOW_SECONDS || (isLocal ? 3 * 24 * 60 * 60 : 15 * 60));

  console.log(`Network:  ${network.name} (chain ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Oracle:   ${oracle}${oracle === deployer.address && !isLocal ? "  (deployer — set ORACLE_ADDRESS for a separate key)" : ""}`);
  console.log(`Arbiter:  ${arbiter}`);

  const deployBlock = await ethers.provider.getBlockNumber();
  const sys = await deploySystem(ethers, {
    admin: deployer,
    oracle,
    arbiter,
    bondPerUnit,
    liabilityPeriod,
    challengeWindow,
  });

  const addr = async (c) => c.getAddress();
  const deployments = {
    network: network.name,
    chainId,
    rpcUrl: isLocal ? "http://127.0.0.1:8545" : PUBLIC_RPC[chainId] || "",
    explorer: EXPLORERS[chainId] || "",
    oracleUrl: process.env.ORACLE_URL || "http://127.0.0.1:8787",
    deployBlock,
    deployer: deployer.address,
    oracle,
    arbiter,
    bondPerUnit: bondPerUnit.toString(),
    liabilityPeriod,
    challengeWindow,
    ActorRegistry: await addr(sys.actors),
    LotRegistry: await addr(sys.lots),
    LiabilityBond: await addr(sys.bond),
    DisputeModule: await addr(sys.disputes),
    RecallEngine: await addr(sys.engine),
  };

  for (const k of ["ActorRegistry", "LotRegistry", "LiabilityBond", "DisputeModule", "RecallEngine"]) {
    console.log(`${k.padEnd(14)} ${deployments[k]}`);
  }

  const json = JSON.stringify(deployments, null, 2) + "\n";
  const depDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(depDir, { recursive: true });
  fs.writeFileSync(path.join(depDir, `${network.name}.json`), json);
  console.log(`Wrote deployments/${network.name}.json`);

  // The UI reads this file; it is only meaningful for a persistent network.
  if (network.name !== "hardhat") {
    fs.writeFileSync(path.join(__dirname, "..", "ui", "src", "deployments.json"), json);
    console.log("Wrote ui/src/deployments.json");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
