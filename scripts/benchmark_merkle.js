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
const { quarantineProof, payoutProof, buildRecallFromChain } = require("./merkle.js");
const { deploySystem, Role } = require("./lib/system.js");
const { signRecall, signRecallMerkle } = require("./lib/eip712.js");

const FANOUT = 4, DEPTH = 3; // 84 descendants
const CID = "bafkreibenchmark";

async function deploy(admin, producer, processor) {
  const sys = await deploySystem(ethers, { admin });
  await sys.actors.registerActor(producer.address, Role.Producer, "Producer");
  await sys.actors.registerActor(processor.address, Role.Processor, "Processor");
  await sys.bond.connect(producer).stakeBond({ value: ethers.parseEther("10") });
  await sys.bond.connect(processor).stakeBond({ value: ethers.parseEther("10") });
  return sys;
}

// Root lot by the (at-fault) producer; every descendant by the processor.
async function buildTree(lots, producer, processor) {
  await (await lots.connect(producer).createLot([], 1, "")).wait(); // root = 1
  let frontier = [1], created = 1;
  for (let d = 0; d < DEPTH; d++) {
    const next = [];
    for (const parent of frontier) {
      for (let f = 0; f < FANOUT; f++) {
        await (await lots.connect(processor).createLot([parent], 1, "")).wait();
        created++; next.push(created);
      }
    }
    frontier = next;
  }
}

async function main() {
  const [admin, producer, processor] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  // --- eager path ---
  const e = await deploy(admin, producer, processor);
  await buildTree(e.lots, producer, processor);
  const eagerSig = await signRecall(admin, {
    engine: await e.engine.getAddress(), chainId, rootLotId: 1, maxNodes: 4096, certificateCID: CID,
  });
  const eagerTx = await (await e.engine.initiateRecall(1, 4096, CID, eagerSig)).wait();
  const eagerGas = eagerTx.gasUsed;
  await time.increase(3 * 24 * 60 * 60 + 1);
  const eagerFinalizeGas = (await (await e.engine.finalizeRecall(1)).wait()).gasUsed;

  // --- merkle path (fresh deploy, same tree) ---
  const m = await deploy(admin, producer, processor);
  await buildTree(m.lots, producer, processor);
  const plan = await buildRecallFromChain(m.lots, 1);
  const { qTree, pTree, totalWeight, affected } = plan;
  const mSig = await signRecallMerkle(admin, {
    engine: await m.engine.getAddress(), chainId, rootLotId: 1,
    quarantineRoot: qTree.root, payoutRoot: pTree.root, totalWeight, certificateCID: CID,
  });
  const mTx = await (await m.engine.initiateRecallMerkle(1, qTree.root, pTree.root, totalWeight, CID, mSig)).wait();
  const merkleInitGas = mTx.gasUsed;
  const lot = affected[affected.length - 1];
  const qTx = await (await m.engine.quarantineWithProof(1, lot, quarantineProof(qTree, lot))).wait();
  const quarantineGas = qTx.gasUsed;
  await time.increase(3 * 24 * 60 * 60 + 1);
  const cTx = await (await m.engine.claimPayout(1, lot, processor.address, 1, payoutProof(pTree, lot, processor.address, 1))).wait();
  const claimGas = cTx.gasUsed;

  const n = affected.length;
  const rows = [
    `# RecallMesh — Eager vs. Merkle recall gas (${n} affected lots, fan-out ${FANOUT}, depth ${DEPTH})`,
    "",
    "| Path | Operation | Gas | Scales with affected-set size? |",
    "|---|---|---|---|",
    `| Eager (on-chain traversal) | initiateRecall (traverse + quarantine all) | ${eagerGas} | yes, O(n) writes + O(n^2) dedup |`,
    `| Eager (on-chain traversal) | finalizeRecall (on-chain payout table + ${n} transfers) | ${eagerFinalizeGas} | yes, O(n) |`,
    `| Merkle-anchored | initiateRecallMerkle (commit roots) | ${merkleInitGas} | no, O(1) |`,
    `| Merkle-anchored | quarantineWithProof (per lot) | ${quarantineGas} | no, O(log n) proof |`,
    `| Merkle-anchored | claimPayout (per holder, pull) | ${claimGas} | no, O(log n) proof |`,
    "",
    `Eager initiation at ${n} lots costs ${eagerGas} gas and settlement another ${eagerFinalizeGas}; both keep ` +
      `growing with the graph and eventually hit the block-gas ceiling. The Merkle path moves that cost off-chain: ` +
      `initiation is constant at ~${merkleInitGas} gas regardless of size, and quarantine/payout become small per-lot ` +
      `proof checks that anyone can submit (pull-based, so no push loop).`,
  ];
  const out = rows.join("\n") + "\n";
  fs.writeFileSync(path.join(__dirname, "..", "docs", "merkle_results.md"), out);
  console.log(out);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
