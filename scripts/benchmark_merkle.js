/**
 * Gas comparison: eager on-chain-traversal recall vs. the Merkle-anchored recall.
 * Builds one DAG, then measures initiation gas both ways plus the per-lot proof ops.
 *   npx hardhat run scripts/benchmark_merkle.js
 */
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { buildQuarantineTree, quarantineProof, buildPayoutTree, payoutProof } = require("./merkle.js");

const Role = { Producer: 1 };
const FANOUT = 4, DEPTH = 3; // 84 descendants

async function deploy(admin) {
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
  await actors.registerActor(a, Role.Producer, "Producer");
  return { actors, bond, disputes, lots, engine };
}

async function buildTree(lots, admin) {
  await (await lots.createLot([], 1, "")).wait(); // root = 1
  let frontier = [1], created = 1;
  for (let d = 0; d < DEPTH; d++) {
    const next = [];
    for (const parent of frontier) {
      for (let f = 0; f < FANOUT; f++) {
        await (await lots.createLot([parent], 1, "")).wait();
        created++; next.push(created);
      }
    }
    frontier = next;
  }
  const affected = [];
  for (let id = 2; id <= created; id++) affected.push(id);
  return affected;
}

async function signEager(signer, engine, rootLotId, atFault, maxNodes) {
  const domain = { name: "RecallMesh", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await engine.getAddress() };
  const types = { Recall: [{ name: "rootLotId", type: "uint256" }, { name: "atFaultActor", type: "address" }, { name: "maxNodes", type: "uint256" }] };
  return signer.signTypedData(domain, types, { rootLotId, atFaultActor: atFault, maxNodes });
}
async function signMerkle(signer, engine, rootLotId, atFault, qRoot, pRoot, tw) {
  const domain = { name: "RecallMesh", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await engine.getAddress() };
  const types = { RecallMerkle: [{ name: "rootLotId", type: "uint256" }, { name: "atFaultActor", type: "address" }, { name: "quarantineRoot", type: "bytes32" }, { name: "payoutRoot", type: "bytes32" }, { name: "totalWeight", type: "uint256" }] };
  return signer.signTypedData(domain, types, { rootLotId, atFaultActor: atFault, quarantineRoot: qRoot, payoutRoot: pRoot, totalWeight: tw });
}

async function main() {
  const [admin] = await ethers.getSigners();

  // --- eager path ---
  const e = await deploy(admin);
  const affected = await buildTree(e.lots, admin);
  await e.bond.stakeBond({ value: ethers.parseEther("1") });
  const eagerSig = await signEager(admin, e.engine, 1, admin.address, 4096);
  const eagerTx = await (await e.engine.initiateRecall(1, admin.address, 4096, eagerSig)).wait();
  const eagerGas = eagerTx.gasUsed;

  // --- merkle path (fresh deploy, same tree) ---
  const m = await deploy(admin);
  await buildTree(m.lots, admin);
  await m.bond.stakeBond({ value: ethers.parseEther("1") });
  const qTree = buildQuarantineTree(affected);
  const entries = affected.map((id) => ({ lotId: id, holder: admin.address, weight: 1 }));
  const pTree = buildPayoutTree(entries);
  const mSig = await signMerkle(admin, m.engine, 1, admin.address, qTree.root, pTree.root, entries.length);
  const mTx = await (await m.engine.initiateRecallMerkle(1, admin.address, qTree.root, pTree.root, entries.length, mSig)).wait();
  const merkleInitGas = mTx.gasUsed;
  const qTx = await (await m.engine.quarantineWithProof(1, affected[affected.length - 1], quarantineProof(qTree, affected[affected.length - 1]))).wait();
  const quarantineGas = qTx.gasUsed;
  await time.increase(3 * 24 * 60 * 60 + 1);
  const lot = affected[affected.length - 1];
  const cTx = await (await m.engine.claimPayout(1, lot, admin.address, 1, payoutProof(pTree, lot, admin.address, 1))).wait();
  const claimGas = cTx.gasUsed;

  const rows = [
    `# RecallMesh — Eager vs. Merkle recall gas (${affected.length} affected lots, fan-out ${FANOUT}, depth ${DEPTH})`,
    "",
    "| Path | Operation | Gas | Scales with affected-set size? |",
    "|---|---|---|---|",
    `| Eager (on-chain traversal) | initiateRecall (traverse + quarantine all) | ${eagerGas.toString()} | yes, O(n) writes + O(n^2) dedup |`,
    `| Merkle-anchored | initiateRecallMerkle (commit roots) | ${merkleInitGas.toString()} | no, O(1) |`,
    `| Merkle-anchored | quarantineWithProof (per lot) | ${quarantineGas.toString()} | no, O(log n) proof |`,
    `| Merkle-anchored | claimPayout (per holder, pull) | ${claimGas.toString()} | no, O(log n) proof |`,
    "",
    `Eager initiation at ${affected.length} lots costs ${eagerGas.toString()} gas and keeps growing with the graph ` +
      `(our earlier sweep hit the block-gas ceiling as the affected set scaled). The Merkle path moves that cost off-chain: ` +
      `initiation is constant at ~${merkleInitGas.toString()} gas regardless of size, and quarantine/payout become small per-lot ` +
      `proof checks that anyone can submit (pull-based, so no push-loop or reentrancy exposure).`,
  ];
  const out = rows.join("\n") + "\n";
  fs.writeFileSync(path.join(__dirname, "..", "docs", "merkle_results.md"), out);
  console.log(out);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
