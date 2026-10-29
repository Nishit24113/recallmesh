#!/bin/bash
# SLURM array job for the RecallMesh gas/scalability sweep on ASU SOL.
# Each array task runs ONE config from bench/configs.json in parallel, so the whole
# grid finishes in the time of the single slowest config. After the array completes,
# run `node scripts/aggregate.js` to merge the per-task results.
#
# Submit from the repo root:   sbatch bench/run_benchmark.sbatch
# (The array range 0-9 matches the 10 configs in bench/configs.json — adjust if you
#  add/remove configs.)

#SBATCH --job-name=recallmesh-bench
#SBATCH --array=0-9
#SBATCH --time=00:20:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=2
#SBATCH --mem=4G
#SBATCH --output=bench/results/slurm_%A_%a.out
#SBATCH --error=bench/results/slurm_%A_%a.err

set -euo pipefail
cd "${SLURM_SUBMIT_DIR:-.}"

# Load Node on SOL (adjust to the module actually available, e.g. `module load nodejs/20`).
module load mamba/latest 2>/dev/null || true
module load nodejs 2>/dev/null || true

# One config per array task.
export CONFIG_INDEX="${SLURM_ARRAY_TASK_ID}"
echo "Running benchmark config index ${CONFIG_INDEX} on $(hostname)"
npx hardhat run scripts/benchmark.js

# NOTE: this Hardhat workload is lightweight (runs in-memory in seconds); the array job
# simply sweeps many DAG configurations concurrently. After all tasks finish, merge with:
#   node scripts/aggregate.js
