/**
 * End-to-end RecallMesh demo (good for the Interim Demo recording).
 * Builds a small food supply chain, contaminates the raw lot, triggers a signed
 * recall, and shows the quarantine propagate through the DAG and the slashed bond
 * paid out pro-rata to downstream holders.
 *
 *   npx hardhat run scripts/demo.js
 */
const hre = require("hardhat");
const { ethers } = hre;
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const Role = { Producer: 1, Processor: 3, Distributor: 4, Retailer: 5 };
const StatusName = ["Active", "Quarantined", "Recalled"];
const fmt = (wei) => ethers.formatEther(wei);

async function signRecall(signer, engine, rootLotId, atFaultActor, maxNodes) {
  const domain = {
    name: "RecallMesh",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await engine.getAddress(),
  };
  const types = {
    Recall: [
      { name: "rootLotId", type: "uint256" },
      { name: "atFaultActor", type: "address" },
      { name: "maxNodes", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, { rootLotId, atFaultActor, maxNodes });
}

async function main() {
  const [admin, farm, mill, dist, store] = await ethers.getSigners();
  const a = admin.address;

  const actors = await ethers.deployContract("ActorRegistry", [a]);
  const bond = await ethers.deployContract("LiabilityBond", [a]);
  const disputes = await ethers.deployContract("DisputeModule", [a, a]);
  const lots = await ethers.deployContract("LotRegistry", [await actors.getAddress(), a]);
  const engine = await ethers.deployContract("RecallEngine", [
    await lots.getAddress(), await bond.getAddress(), await disputes.getAddress(),
    await actors.getAddress(), a, a,
  ]);
  await lots.setRecallEngine(await engine.getAddress());
  await bond.setRecallEngine(await engine.getAddress());
  await disputes.setRecallEngine(await engine.getAddress());

  await actors.registerActor(farm.address, Role.Producer, "GreenField Farm");
  await actors.registerActor(mill.address, Role.Processor, "FreshWash Processor");
  await actors.registerActor(dist.address, Role.Distributor, "ColdChain Distributor");
  await actors.registerActor(store.address, Role.Retailer, "City Grocer");

  console.log("\n=== 1. Build the provenance DAG (a spinach supply chain) ===");
  await (await lots.connect(farm).createLot([], 100, "ipfs://raw-spinach")).wait(); // L1
  await (await lots.connect(mill).createLot([1], 80, "ipfs://washed")).wait();       // L2
  await (await lots.connect(mill).createLot([2], 80, "ipfs://bagged-salad")).wait(); // L3
  await (await lots.connect(dist).createLot([3], 60, "ipfs://pallet")).wait();       // L4
  await (await lots.connect(store).createLot([4], 40, "ipfs://shelf-units")).wait(); // L5
  await (await lots.connect(farm).createLot([], 50, "ipfs://unrelated-kale")).wait(); // L6 (unrelated)
  console.log("  L1 raw spinach (Farm) -> L2 washed (Processor) -> L3 bagged salad -> L4 pallet (Dist) -> L5 shelf (Store)");
  console.log("  L6 kale (Farm) — unrelated branch");

  console.log("\n=== 2. Actors stake liability bonds ===");
  await bond.connect(farm).stakeBond({ value: ethers.parseEther("1") });
  console.log(`  Farm staked ${fmt(await bond.bondOf(farm.address))} ETH bond`);

  console.log("\n=== 3. Lab detects contamination in raw lot L1; regulator signs a recall ===");
  const sig = await signRecall(admin, engine, 1, farm.address, 4096);
  await (await engine.initiateRecall(1, farm.address, 4096, sig)).wait();
  console.log("  RecallEngine verified the EIP-712 signature and ran the recall.");

  console.log("\n=== 4. Quarantine propagated through the DAG ===");
  for (let id = 1; id <= 6; id++) {
    const l = await lots.getLot(id);
    console.log(`  Lot ${id}: ${StatusName[Number(l.status)]}`);
  }
  console.log(`  Farm bond after slash: ${fmt(await bond.bondOf(farm.address))} ETH (slashed into escrow)`);

  console.log("\n=== 5. Dispute window elapses with no challenge; finalize pays downstream holders ===");
  await time.increase(3 * 24 * 60 * 60 + 1);
  const holders = [mill.address, dist.address, store.address];
  const weights = [160n, 60n, 40n]; // processor holds L2+L3=160, dist L4=60, store L5=40
  const before = await Promise.all(holders.map((h) => ethers.provider.getBalance(h)));
  await (await engine.finalizeRecall(1, holders, weights)).wait();
  const after = await Promise.all(holders.map((h) => ethers.provider.getBalance(h)));
  const names = ["Processor", "Distributor", "Retailer"];
  holders.forEach((_, i) => console.log(`  ${names[i]} received ${fmt(after[i] - before[i])} ETH`));
  console.log("\nDemo complete.\n");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
