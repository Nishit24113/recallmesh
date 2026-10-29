# RecallMesh — Benchmark Harness

Measures how the recall path's gas cost scales with the size/shape of the provenance DAG.
This feeds the **Analysis** section of the final report (gas vs. DAG depth and fan-out) and
motivates the planned Merkle-membership path for large graphs.

## What it measures (per config)

- **descendants** — number of downstream lots reachable from the recalled root.
- **traversalGas** — gas for `LotRegistry.affectedDescendants(root, maxNodes)` (the DAG walk).
- **recallGas** — gas for the full `RecallEngine.initiateRecall(...)` (traversal + quarantine
  loop + slash + open dispute).

Configs live in [`configs.json`](configs.json): chains (fan-out 1) and balanced 2/3/4-ary trees
at increasing depth.

## Run locally (serial)

```bash
for i in $(seq 0 9); do CONFIG_INDEX=$i npx hardhat run scripts/benchmark.js; done
node scripts/aggregate.js      # -> bench/results/summary.csv + docs/benchmark_results.md
```

## Run on ASU SOL (parallel SLURM array)

Each config runs as an independent array task, so the whole sweep finishes in the time of the
single slowest config:

```bash
sbatch bench/run_benchmark.sbatch   # launches array tasks 0-9 (one per config)
# after the array completes:
node scripts/aggregate.js
```

Adjust `--array=0-9` in `run_benchmark.sbatch` if you change the number of configs, and set the
correct `module load` line for Node on SOL.

> **Honest note:** each Hardhat run is lightweight (in-memory, seconds) and does not *need* a
> supercomputer. The array job is a convenient way to sweep many DAG configurations at once and,
> later, to run heavier experiments (e.g., ZK-proving the affected set) where SOL's GPUs do help.

## Results

`scripts/aggregate.js` writes a CSV (`bench/results/summary.csv`) and a committed Markdown table
(`docs/benchmark_results.md`). The raw `result_*.json` and SLURM logs are gitignored.
