/**
 * RecallMesh gas/scalability benchmark — ONE DAG configuration per invocation.
 *
 * Picks a config from bench/configs.json by index (env CONFIG_INDEX, or a SLURM
 * array task id via SLURM_ARRAY_TASK_ID), builds a balanced `fanout`-ary provenance
 * tree of the given `depth`, runs a recall from the root, and records gas for:
 *   - affectedDescendants(...)  (the DAG traversal, measured via estimateGas)
 *   - initiateRecall(...)       (traversal + quarantine loop + slash + open dispute)
 *   - finalizeRecall(...)       (on-chain pro-rata payout table + transfers)
 *
 * The root lot is produced by `producer` (the at-fault actor); every descendant is
 * produced by `processor`, so each affected lot yields one payout entry.
 *
 * Writes bench/results/result_<index>.json. Because each config is independent and
 * gas is deterministic, the configs can be fanned out across parallel SLURM array
 * tasks on ASU SOL (see bench/run_benchmark.sbatch) and merged with scripts/aggregate.js.
 */
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySystem, Role } = require("./lib/system.js");
const { signRecall } = require("./lib/eip712.js");

const MAX_NODES = 4096; // traversal cap; large enough to capture the whole tree here
const CID = "bafkreibenchmark";

async function main() {
  const idx = parseInt(process.env.CONFIG_INDEX ?? process.env.SLURM_ARRAY_TASK_ID ?? "0", 10);
  const configs = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "bench", "configs.json"), "utf8"));
  if (idx < 0 || idx >= configs.length) throw new Error(`CONFIG_INDEX ${idx} out of range (0..${configs.length - 1})`);
  const cfg = configs[idx];

  const [admin, producer, processor] = await ethers.getSigners();
  const { actors, bond, lots, engine } = await deploySystem(ethers, { admin });
  await actors.registerActor(producer.address, Role.Producer, "Bench producer");
  await actors.registerActor(processor.address, Role.Processor, "Bench processor");
  await bond.connect(producer).stakeBond({ value: ethers.parseEther("10") });
  await bond.connect(processor).stakeBond({ value: ethers.parseEther("10") });

  // Build a balanced fanout-ary tree rooted at lot 1. Lot ids increment sequentially,
  // so the running `created` count equals the newest lot id.
  await (await lots.connect(producer).createLot([], 1, "")).wait();
  let created = 1;
  const rootId = 1;
  let frontier = [rootId];
  for (let d = 0; d < cfg.depth; d++) {
    const next = [];
    for (const parent of frontier) {
      for (let f = 0; f < cfg.fanout; f++) {
        await (await lots.connect(processor).createLot([parent], 1, "")).wait();
        created += 1;
        next.push(created);
      }
    }
    frontier = next;
  }
  const descendants = created - 1;

  // Measure traversal gas (view) and full recall gas (state-changing).
  let traversalGas = null;
  try {
    traversalGas = (await lots.affectedDescendants.estimateGas(rootId, MAX_NODES)).toString();
  } catch (e) {
    traversalGas = "exceeds-estimate";
  }

  let recallGas = null;
  let finalizeGas = null;
  let recallNote = "ok";
  try {
    const sig = await signRecall(admin, {
      engine: await engine.getAddress(),
      chainId: (await ethers.provider.getNetwork()).chainId,
      rootLotId: rootId,
      maxNodes: MAX_NODES,
      certificateCID: CID,
    });
    const rc = await (await engine.initiateRecall(rootId, MAX_NODES, CID, sig)).wait();
    recallGas = rc.gasUsed.toString();
    await time.increase(3 * 24 * 60 * 60 + 1);
    const fc = await (await engine.finalizeRecall(1)).wait();
    finalizeGas = fc.gasUsed.toString();
  } catch (e) {
    recallNote = "reverted (likely exceeds block gas limit)";
  }

  const result = {
    index: idx,
    label: cfg.label,
    fanout: cfg.fanout,
    depth: cfg.depth,
    descendants,
    traversalGas,
    recallGas,
    finalizeGas,
    recallNote,
  };

  const outDir = path.join(__dirname, "..", "bench", "results");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `result_${idx}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
