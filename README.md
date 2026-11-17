# RecallMesh

**A blockchain supply-chain provenance system with collateralized, topology-aware recall liability.**
CSE 540 — Engineering Blockchain Applications (Fall B 2026), Project Group 12.

> **Status.** The contracts, oracle service, IPFS integration, dApp and benchmarks are complete
> (**36 passing tests**). Polygon Amoy deployment is scripted (`npm run deploy:amoy`). It is waiting
> on a faucet-funded key; see [Deploy to Polygon Amoy](#deploy-to-polygon-amoy).

## What it does

Ordinary supply-chain provenance systems record *where* a product went. RecallMesh makes the
provenance edges carry **enforceable, collateralized liability**:

1. **Producing a lot locks collateral** in proportion to its quantity, for a liability period.
2. A lab or regulator **oracle** publishes its test certificate to **IPFS** and signs an EIP-712
   recall for the defective **root lot**. The signature binds the certificate's CID.
3. The contract **derives the at-fault actor from the graph** (the root lot's producer),
   **traverses the provenance DAG** and **quarantines** every descendant lot. Frozen lots cannot
   move by any transfer path.
4. The bond locked for the root lot is **slashed into escrow**. The accused can **challenge**
   within a window, and an arbiter upholds or overturns.
5. Settlement **pays downstream holders pro-rata** to the quarantined units they hold, computed
   on-chain, or **refunds** the accused if the attribution was overturned.

The novelty is that the same graph traversal decides what is quarantined, who pays, and who is
paid. See [`docs/architecture.md`](docs/architecture.md) and [`docs/prior_art.md`](docs/prior_art.md).

## Contract overview

| Contract | Responsibility |
|---|---|
| `ActorRegistry` | Registers participants (producer, supplier, processor, distributor, retailer, regulator). |
| `LotRegistry` (ERC-1155) | Lots as tokens with parent edges (the DAG); bounded descendant traversal; freeze enforced in the single `_update` hook; holder tracking; locks bond on `createLot`. |
| `LiabilityBond` | Free and locked bond per actor; per-lot locks (`bondPerUnit × qty`, `liabilityPeriod`); slashing into per-recall escrow; pro-rata payout with credit fallback; refunds. |
| `RecallEngine` | Verifies the oracle's EIP-712 recall, derives fault from the DAG, quarantines (eager BFS or Merkle proofs), slashes, opens the dispute, settles. |
| `DisputeModule` | UMA-style challenge window plus arbiter, so slashing is never unilateral. |

Shared enums and structs live in `contracts/interfaces/Types.sol`. Each contract has a matching
interface in `contracts/interfaces/`.

### Two recall modes

| | Eager | Merkle-anchored |
|---|---|---|
| Initiate | `initiateRecall(root, maxNodes, certCID, sig)`: on-chain BFS + quarantine | `initiateRecallMerkle(root, qRoot, pRoot, totalWeight, certCID, sig)`: O(1) |
| Quarantine | in the initiate tx | `quarantineWithProof(recallId, lotId, proof)`, permissionless |
| Settle (upheld) | `finalizeRecall(recallId)`: payout table computed on-chain | `claimPayout(recallId, lotId, holder, weight, proof)`: pays the holder |
| Settle (overturned) | `finalizeRecall`: refund | `finalizeRecall`: refund |
| Gas at 84 lots | 2.33M init + 2.94M finalize | 0.36M init, ~76K per quarantine, ~103K per claim |

Full numbers: [`docs/benchmark_results.md`](docs/benchmark_results.md) and
[`docs/merkle_results.md`](docs/merkle_results.md).

## Repository structure

```
contracts/            the five contracts + interfaces/ (+ test/RejectingHolder.sol, test-only)
offchain/
  oracle.js           lab/regulator oracle service (HTTP, port 8787)
  ipfs.js             IPFS content IDs (standard CIDv1) + local content store
scripts/
  lib/system.js       deploy + wire all contracts (shared by every script and the tests)
  lib/eip712.js       recall signing (eager + Merkle)
  merkle.js           Merkle trees/proofs + buildRecallFromChain()
  deploy.js           deploy to any network; writes deployments/<net>.json + ui/src/deployments.json
  seed.js             demo actors, bonds and an 8-lot DAG with IPFS metadata
  simulate-feed.js    simulated lab/IoT feed posting to the oracle
  demo.js             one-shot terminal demo on the in-process chain
  benchmark.js, aggregate.js, benchmark_merkle.js   gas benchmarks
test/                 Hardhat tests (contracts, Merkle path, oracle + IPFS)
ui/                   React + Ethers.js + React Flow dApp
bench/                benchmark configs + SLURM array job for ASU SOL
docs/                 architecture, prior art, bond sizing, benchmark results
```

## Setup

- **Node.js** ≥ 18 (tested on 22) and **npm**
- **Hardhat** + `@nomicfoundation/hardhat-toolbox`, **Solidity 0.8.24**, **OpenZeppelin Contracts 5**

```bash
npm install
npx hardhat compile
npx hardhat test                 # 36 passing
npm run demo                     # terminal walkthrough on an in-process chain
```

## Run the full local stack

```bash
npx hardhat node                 # terminal 1: local chain
npm run deploy:local             # terminal 2: deploy + write ui/src/deployments.json
npm run seed:local               #             demo actors, bonds, 8-lot DAG
npm run oracle                   # terminal 3: oracle service on :8787
cd ui && npm install && npm run dev   # terminal 4: open the printed URL
```

In MetaMask, add the local network (RPC `http://127.0.0.1:8545`, chain id `31337`) and import
Hardhat account **#0**, which is the admin and arbiter. Seeded actors are accounts #3–#6 (Farm,
Mill, Distributor, Grocer). Import #3 to try a challenge as the accused farm. The oracle service
signs with account #1.

To drive a recall without the UI: `npm run feed` (add `MODE=merkle SUBMIT=1` to have the oracle
submit a Merkle recall itself).

### Oracle service API

| Route | Purpose |
|---|---|
| `GET /health` | oracle address, chain, IPFS mode |
| `POST /lab-results` | `{lotId, result: "pass"\|"fail", test?, lab?, reading?, mode?: "eager"\|"merkle", submit?}` → certificate CID + signed recall |
| `GET /recalls/:id/proofs[?holder=]` | Merkle quarantine + payout proofs |
| `POST /recalls/:id/quarantine-all` | relay `quarantineWithProof` for every affected lot |
| `POST /recalls/:id/claim-all` | relay `claimPayout` for every entry (funds always go to the holder) |
| `POST /ipfs`, `GET /ipfs/:cid` | store / read JSON or bytes |

## Deploy to Polygon Amoy

1. `cp .env.example .env`, then set `AMOY_RPC_URL` and `PRIVATE_KEY` (deployer, funded from the
   [Amoy faucet](https://faucet.polygon.technology/)). These are the only required values; the
   deployer key also acts as the oracle signer unless you set `ORACLE_PRIVATE_KEY`.
2. Deploy and seed:
   ```bash
   npm run deploy:amoy          # writes deployments/amoy.json + ui/src/deployments.json
   npm run seed:amoy            # funds 4 generated actor wallets (keys in deployments/amoy-actors.json, gitignored)
   ```
3. Run the oracle (`npm run oracle`; it uses `AMOY_RPC_URL` and `PRIVATE_KEY`) and start the UI.

On testnets the challenge window defaults to 15 minutes (`CHALLENGE_WINDOW_SECONDS`), so a live
demo can auto-uphold without waiting days, and `bondPerUnit` defaults to 0.0001 POL.

## Parameters

| Parameter | Where | Default |
|---|---|---|
| `bondPerUnit` | `LiabilityBond.setBondPerUnit` | 0.01 ETH local / 0.0001 POL Amoy |
| `liabilityPeriod` | `LiabilityBond.setLiabilityPeriod` | 30 days |
| `challengeWindow` | `RecallEngine.setChallengeWindow` | 3 days local / 15 min Amoy |
| oracle / arbiter | `RecallEngine.setOracle` / `DisputeModule.setArbiter` | account #1 locally, deployer on Amoy / deployer |

Sizing rationale: [`docs/bond_sizing.md`](docs/bond_sizing.md).

## Benchmarks

```bash
for i in $(seq 0 9); do CONFIG_INDEX=$i npx hardhat run scripts/benchmark.js; done
node scripts/aggregate.js        # -> docs/benchmark_results.md
npm run bench:merkle             # -> docs/merkle_results.md
sbatch bench/run_benchmark.sbatch   # parallel sweep on ASU SOL
```

## Team

Jash Ramde Karangiya · Krish Patel · Nishit Pankajkumar Patel · Pratham Manish Savjani · Yahia Alqurnawi

## License

MIT
