/**
 * RecallMesh gas/scalability benchmark — ONE DAG configuration per invocation.
 *
 * Picks a config from bench/configs.json by index (env CONFIG_INDEX, or a SLURM
 * array task id via SLURM_ARRAY_TASK_ID), builds a balanced `fanout`-ary provenance
 * tree of the given `depth`, runs a recall from the root, and records gas for:
 *   - affectedDescendants(...)  (the DAG traversal, measured via estimateGas)
 *   - initiateRecall(...)       (traversal + quarantine loop + slash + open dispute)
 *
 * Writes bench/results/result_<index>.json. Because each config is independent and
 * gas is deterministic, the configs can be fanned out across parallel SLURM array
 * tasks on ASU SOL (see bench/run_benchmark.sbatch) and merged with scripts/aggregate.js.
 */
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

const Role = { Producer: 1 };
const MAX_NODES = 4096; // traversal cap; large enough to capture the whole tree here

async function deployAll(admin) {
  const a = admin.address;
  const actors = await ethers.deployContract("ActorRegistry", [a]);
  const bond = await ethers.deployContract("LiabilityBond", [a]);
  const disputes = await ethers.deployContract("DisputeModule", [a, a]);
  const lots = await ethers.deployContract("LotRegistry", [await actors.getAddress(), a]);
  const engine = await ethers.deployContract("RecallEngine", [
    await lots.getAddress(),
    await bond.getAddress(),
    await disputes.getAddress(),
    await actors.getAddress(),
    a,
    a,
  ]);
  await lots.setRecallEngine(await engine.getAddress());
  await bond.setRecallEngine(await engine.getAddress());
  await disputes.setRecallEngine(await engine.getAddress());
  return { actors, bond, disputes, lots, engine };
}

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
  const idx = parseInt(process.env.CONFIG_INDEX ?? process.env.SLURM_ARRAY_TASK_ID ?? "0", 10);
  const configs = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "bench", "configs.json"), "utf8"));
  if (idx < 0 || idx >= configs.length) throw new Error(`CONFIG_INDEX ${idx} out of range (0..${configs.length - 1})`);
  const cfg = configs[idx];

  const [admin, producer] = await ethers.getSigners();
  const { actors, bond, lots, engine } = await deployAll(admin);
  await actors.registerActor(producer.address, Role.Producer, "Bench");
  await bond.connect(producer).stakeBond({ value: ethers.parseEther("1") });

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
        await (await lots.connect(producer).createLot([parent], 1, "")).wait();
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
  let recallNote = "ok";
  try {
    const sig = await signRecall(admin, engine, rootId, producer.address, MAX_NODES);
    const rc = await (await engine.initiateRecall(rootId, producer.address, MAX_NODES, sig)).wait();
    recallGas = rc.gasUsed.toString();
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
