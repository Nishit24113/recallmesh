# RecallMesh

**A blockchain supply-chain provenance system with collateralized, topology-aware recall liability.**
CSE 540 — Engineering Blockchain Applications (Fall B 2026), Project Group 12.

> **Status.** The Deliverable-2 design draft (structure, interfaces, documented logic) is in
> place, and the **core recall flow is now implemented and tested end-to-end** (9 passing tests)
> with a **gas/scalability benchmark** and a runnable **demo**. Still to come in later milestones:
> the React/Ethers.js UI, off-chain oracle/IPFS wiring, and the remaining `TODO`s (Merkle-scaling
> for very large graphs, bond-sizing policy).

## What it does

Ordinary supply-chain provenance systems record *where* a product went. RecallMesh makes the
provenance edges carry **enforceable, collateralized liability**. When an authorized oracle
(a regulator or accredited lab) signs a recall for a defective **root lot**, the system:

1. **traverses the provenance DAG** to compute the exact set of affected *descendant* lots,
2. **quarantines** (freezes) those lots,
3. **slashes** the at-fault actor's staked bond into escrow, and
4. after a **dispute window**, pays the slashed collateral **pro-rata to downstream holders**.

The novelty is keying slashing and compensation to the **topology** of the provenance graph —
not a flat two-party policy. See [`docs/architecture.md`](docs/architecture.md) and the diagram
in [`docs/architecture.png`](docs/architecture.png).

## Contract overview

| Contract | Responsibility |
|---|---|
| `ActorRegistry` | Registers participants (producer, supplier, …, regulator) and their roles. |
| `LotRegistry` (ERC-1155) | Lots as tokens; stores parent lot IDs → the provenance DAG; bounded descendant traversal; status (Active/Quarantined/Recalled). |
| `LiabilityBond` | Neutral custody of staked bonds; slashing into per-recall escrow; pro-rata payout. |
| `RecallEngine` | Orchestrator: verifies the EIP-712 oracle recall, quarantines descendants, slashes, opens dispute, finalizes payout. |
| `DisputeModule` | UMA-style challenge window so slashing is not unilateral. |

Shared enums/structs live in `contracts/interfaces/Types.sol`; each contract has a matching
interface in `contracts/interfaces/`.

## Repository structure

```
contracts/
  interfaces/        shared Types + one interface per contract
  ActorRegistry.sol
  LotRegistry.sol
  LiabilityBond.sol
  RecallEngine.sol
  DisputeModule.sol
scripts/
  deploy.js          deploys and wires all five contracts
  demo.js            end-to-end demo (build DAG -> recall -> quarantine -> payout)
  benchmark.js       gas/scalability benchmark for ONE DAG config (CONFIG_INDEX)
  aggregate.js       merges benchmark results into CSV + a Markdown table
test/                Hardhat tests (recall flow, EIP-712, slashing, dispute)
bench/               benchmark configs + SLURM array job for ASU SOL
docs/                architecture notes + diagram + benchmark results
```

## Dependencies & setup

- **Node.js** ≥ 18, **npm**
- **Hardhat** + `@nomicfoundation/hardhat-toolbox`, **Solidity 0.8.24**
- **OpenZeppelin Contracts** ^5.x (ERC-1155, AccessControl, Ownable, ReentrancyGuard, EIP712/ECDSA)

```bash
npm install          # install dependencies
npx hardhat compile  # compile the contracts
npx hardhat test     # run the test suite (9 passing)
npx hardhat run scripts/demo.js   # run the end-to-end demo
```

### Benchmarks (gas vs. DAG size)

```bash
# local sweep over all configs, then merge:
for i in $(seq 0 9); do CONFIG_INDEX=$i npx hardhat run scripts/benchmark.js; done
node scripts/aggregate.js         # -> bench/results/summary.csv + docs/benchmark_results.md
# on ASU SOL (parallel SLURM array, one config per task):
sbatch bench/run_benchmark.sbatch
```

See [`bench/README.md`](bench/README.md) and the committed results in
[`docs/benchmark_results.md`](docs/benchmark_results.md).

## Deploy (local)

```bash
npx hardhat node                               # start a local chain (terminal 1)
npx hardhat run scripts/deploy.js --network localhost   # deploy + wire (terminal 2)
```

For the Polygon **Amoy** testnet, set `AMOY_RPC_URL` and `PRIVATE_KEY` in a `.env` file and run
with `--network amoy` (see `hardhat.config.js`).

## Intended usage (high level)

1. Admin registers actors in `ActorRegistry`; actors `stakeBond()` in `LiabilityBond`.
2. Producers/processors `createLot(parents, amount, metadataURI)` to build the DAG; custody moves
   via `transferCustody`.
3. On a defect, the regulator/lab signs an EIP-712 `Recall(rootLotId, atFaultActor, maxNodes)`;
   anyone submits it via `RecallEngine.initiateRecall(...)`.
4. After the dispute window, `finalizeRecall(recallId, holders, weights)` pays downstream holders.
   (`holders`/`weights` are computed off-chain from the `LotsQuarantined` event and ERC-1155 balances.)

## Platform

Solidity on **Polygon Amoy** (local **Hardhat** for development/tests). Chosen for mature EVM
tooling, reusable ERC-1155/ERC-3643 standards, and near-zero testnet cost.

## Team

Jash Ramde Karangiya · Krish Patel · Nishit Pankajkumar Patel · Pratham Manish Savjani · Yahia Alqurnawi

## License

MIT
