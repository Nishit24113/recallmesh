# RecallMesh UI

React + Ethers.js + React Flow frontend for RecallMesh. All state is read from the chain: the
provenance graph comes from `LotRegistry`, lot names come from each lot's IPFS metadata, and the
settlement ledger is rebuilt from contract events. Nothing is hardcoded.

## Panels

- **Left: setup.** Register actors (admin), stake or withdraw bond, create lots (metadata goes to
  IPFS via the oracle service; the form shows how much bond the lot will lock), move custody.
- **Centre: provenance graph.** Laid out by DAG depth and coloured by status (green active, amber
  quarantined, red recalled; roots are outlined). A recall replays as a wave, layer by layer from
  the root.
- **Centre: settlement ledger.** A live table of stakes, locks, slashes, refunds, payouts,
  challenges and rulings, with explorer links on Amoy.
- **Right: lab result → recall.** Pick a lot, a test and pass/fail, then choose Eager or Merkle
  mode. The oracle publishes the certificate and signs the recall, and your wallet submits it.
  Merkle quarantine proofs are relayed by the oracle.
- **Right: dispute & settlement.** The accused can challenge (evidence goes to IPFS). The arbiter
  can uphold or overturn. On a local chain there is a "Skip challenge window" button. Then
  finalize (eager payout or refund), or claim / relay all claims (Merkle).

## Run it

From the repo root (see the main README for details):

```bash
npx hardhat node
npm run deploy:local && npm run seed:local
npm run oracle
cd ui && npm install && npm run dev
```

Connect MetaMask to `http://127.0.0.1:8545` (chain id `31337`) and import Hardhat account #0
(admin and arbiter), or #3 to act as the farm.

`src/deployments.json` is written by `scripts/deploy.js`. It holds the contract addresses, RPC,
explorer, oracle URL and deploy block. A credited payout (one whose transfer was rejected) shows
as a "Withdraw … credited" button in the top bar.
