# RecallMesh UI

A React + Ethers.js + React-Flow frontend for RecallMesh. The provenance graph is
**built dynamically from on-chain `LotCreated` events** (no hardcoded nodes),
auto-laid-out by DAG depth, and recoloured live as a recall propagates
(green = active, amber = quarantined, red = recalled).

## Features
- Connect a wallet (MetaMask) or fall back to a read-only local RPC connection.
- Register actors, stake liability bonds, and create lots (building the provenance DAG).
- Visualize the DAG; trigger a recall (signs the EIP-712 message in the wallet, calls
  `initiateRecall`) and watch the affected descendants quarantine.
- Resolve the dispute (arbiter, demo convenience) and pay downstream holders pro-rata.

## Run it

From the repo root, start a local chain and deploy (this writes the contract addresses
into `ui/src/deployments.json` automatically):

```bash
npx hardhat node                                       # terminal 1
npx hardhat run scripts/deploy.js --network localhost  # terminal 2
```

Then start the UI:

```bash
cd ui
npm install
npm run dev        # open the printed localhost URL
```

Connect MetaMask to the local network (RPC `http://127.0.0.1:8545`, chain id `31337`) and
import a Hardhat test account to sign transactions.

The graph layout is derived from the on-chain lineage (each lot's parent links), so the view
always reflects the current ledger state with no hardcoded topology.
