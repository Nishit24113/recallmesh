/**
 * Deploys and wires the five RecallMesh contracts.
 * Deploy order matters: the registries/bond/dispute come first, then RecallEngine,
 * then we point each dependency at the RecallEngine address.
 *
 * Draft: for the demo, admin/oracle/arbiter are all the deployer. In a real
 * deployment these would be distinct consortium/regulator keys.
 */
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const me = deployer.address;
  console.log("Deployer:", me);

  const ActorRegistry = await hre.ethers.deployContract("ActorRegistry", [me]);
  await ActorRegistry.waitForDeployment();

  const LiabilityBond = await hre.ethers.deployContract("LiabilityBond", [me]);
  await LiabilityBond.waitForDeployment();

  const DisputeModule = await hre.ethers.deployContract("DisputeModule", [me, me]); // arbiter, owner
  await DisputeModule.waitForDeployment();

  const LotRegistry = await hre.ethers.deployContract("LotRegistry", [
    await ActorRegistry.getAddress(),
    me,
  ]);
  await LotRegistry.waitForDeployment();

  const RecallEngine = await hre.ethers.deployContract("RecallEngine", [
    await LotRegistry.getAddress(),
    await LiabilityBond.getAddress(),
    await DisputeModule.getAddress(),
    await ActorRegistry.getAddress(),
    me, // oracle (regulator/lab signer)
    me, // owner
  ]);
  await RecallEngine.waitForDeployment();

  // Wire the RecallEngine address into the contracts it drives.
  const engine = await RecallEngine.getAddress();
  await (await LotRegistry.setRecallEngine(engine)).wait();
  await (await LiabilityBond.setRecallEngine(engine)).wait();
  await (await DisputeModule.setRecallEngine(engine)).wait();

  console.log("ActorRegistry:", await ActorRegistry.getAddress());
  console.log("LotRegistry:  ", await LotRegistry.getAddress());
  console.log("LiabilityBond:", await LiabilityBond.getAddress());
  console.log("DisputeModule:", await DisputeModule.getAddress());
  console.log("RecallEngine: ", engine);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
