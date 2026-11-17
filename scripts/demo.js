/**
 * End-to-end RecallMesh demo (terminal version of the UI walkthrough).
 * Builds a small food supply chain with throughput-sized bond locks, contaminates the
 * raw lot, has the oracle sign a recall bound to a lab certificate CID, and shows the
 * quarantine propagate, the at-fault producer derived from the graph, and the slashed
 * lock paid out pro-rata (computed on-chain) to downstream holders.
 *
 *   npx hardhat run scripts/demo.js
 */
const hre = require("hardhat");
const { ethers } = hre;
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySystem, Role, StatusName } = require("./lib/system.js");
const { signRecall } = require("./lib/eip712.js");
const { putJSON } = require("../offchain/ipfs.js");

const fmt = (wei) => ethers.formatEther(wei);

async function main() {
  const [admin, oracle, farm, mill, dist, store] = await ethers.getSigners();
  const { actors, bond, lots, engine } = await deploySystem(ethers, {
    admin,
    oracle: oracle.address,
    bondPerUnit: ethers.parseEther("0.01"),
  });

  await actors.registerActor(farm.address, Role.Producer, "GreenField Farm");
  await actors.registerActor(mill.address, Role.Processor, "FreshWash Processor");
  await actors.registerActor(dist.address, Role.Distributor, "ColdChain Distributor");
  await actors.registerActor(store.address, Role.Retailer, "City Grocer");

  console.log("\n=== 1. Actors stake liability bonds (0.01 ETH per unit they will produce) ===");
  for (const [who, name, amt] of [[farm, "Farm", "2"], [mill, "Processor", "2"], [dist, "Distributor", "1"], [store, "Retailer", "1"]]) {
    await (await bond.connect(who).stakeBond({ value: ethers.parseEther(amt) })).wait();
    console.log(`  ${name} staked ${amt} ETH`);
  }

  console.log("\n=== 2. Build the provenance DAG (a spinach supply chain); each lot locks bond ===");
  await (await lots.connect(farm).createLot([], 100, "ipfs://raw-spinach")).wait(); // L1
  await (await lots.connect(mill).createLot([1], 80, "ipfs://washed")).wait();       // L2
  await (await lots.connect(mill).createLot([2], 80, "ipfs://bagged-salad")).wait(); // L3
  await (await lots.connect(dist).createLot([3], 60, "ipfs://pallet")).wait();       // L4
  await (await lots.connect(store).createLot([4], 40, "ipfs://shelf-units")).wait(); // L5
  await (await lots.connect(farm).createLot([], 50, "ipfs://unrelated-kale")).wait(); // L6 (unrelated)
  console.log("  L1 raw spinach (Farm) -> L2 washed (Processor) -> L3 bagged salad -> L4 pallet (Dist) -> L5 shelf (Store)");
  console.log("  L6 kale (Farm) — unrelated branch");
  console.log(`  Farm: ${fmt(await bond.lockedOf(farm.address))} ETH locked, ${fmt(await bond.bondOf(farm.address))} ETH free`);

  console.log("\n=== 3. Lab detects Listeria in L1; certificate goes to IPFS; oracle signs the recall ===");
  const cert = await putJSON({
    type: "RecallMesh/LabCertificate",
    lotId: 1,
    lab: "State Food Safety Lab",
    test: "Listeria monocytogenes PCR",
    result: "fail",
    issuedAt: new Date().toISOString(),
  });
  console.log(`  certificate: ${cert.uri}`);
  const sig = await signRecall(oracle, {
    engine: await engine.getAddress(),
    chainId: (await ethers.provider.getNetwork()).chainId,
    rootLotId: 1,
    maxNodes: 4096,
    certificateCID: cert.cid,
  });
  await (await engine.initiateRecall(1, 4096, cert.cid, sig)).wait();
  const r = await engine.getRecall(1);
  console.log(`  RecallEngine verified the signature; at-fault actor derived from the DAG: ${r.atFaultActor === farm.address ? "Farm" : r.atFaultActor}`);

  console.log("\n=== 4. Quarantine propagated through the DAG ===");
  for (let id = 1; id <= 6; id++) {
    const l = await lots.getLot(id);
    console.log(`  Lot ${id}: ${StatusName[Number(l.status)]}`);
  }
  console.log(`  Slashed ${fmt(r.slashed)} ETH (the lock posted for L1's 100 units) into escrow`);

  console.log("\n=== 5. Dispute window elapses with no challenge; finalize pays downstream holders ===");
  await time.increase(3 * 24 * 60 * 60 + 1);
  const holders = [mill, dist, store];
  const before = await Promise.all(holders.map((h) => ethers.provider.getBalance(h.address)));
  await (await engine.connect(admin).finalizeRecall(1)).wait(); // anyone may call; recipients computed on-chain
  const after = await Promise.all(holders.map((h) => ethers.provider.getBalance(h.address)));
  ["Processor", "Distributor", "Retailer"].forEach((name, i) =>
    console.log(`  ${name} received ${fmt(after[i] - before[i])} ETH`)
  );
  console.log("\nDemo complete.\n");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
