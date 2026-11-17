# RecallMesh — Architecture

![RecallMesh architecture](architecture.png)

*Figure 1. RecallMesh system architecture and recall data flow.* (The figure predates the
oracle service and the per-lot bond lock; the text below is current.)

## Layers

- **Participants** (mutually distrusting): producer, supplier/processor, distributor, retailer,
  a regulator/accredited lab that authorises recalls (the **oracle**), and a dispute **arbiter**.
- **Off-chain**
  - `offchain/oracle.js` — the lab/regulator service. It publishes every lab result as a
    certificate on IPFS and, for a failing result, signs an EIP-712 recall bound to that
    certificate's CID. In Merkle mode it also builds the affected-set and payout Merkle trees and
    serves (or relays) the proofs.
  - `offchain/ipfs.js` — lot metadata, lab certificates and dispute evidence live on IPFS; only
    CIDs go on-chain. CIDs are standard CIDv1s (identical to `ipfs add --cid-version=1` for
    files up to 256 KiB), computed locally; the oracle serves the bytes.
  - `scripts/simulate-feed.js` — simulated lab/IoT feed standing in for real sensors/inspectors.
  - `ui/` — React + Ethers.js + React Flow dApp (provenance graph, animated quarantine, dispute
    flow, live settlement ledger).
- **On-chain (Solidity, Polygon Amoy / local Hardhat):** the five contracts below.

## Contracts & responsibilities

- **ActorRegistry** — identities and roles; gates who may create and hold lots.
- **LotRegistry (ERC-1155)** — lots as tokens, each storing its parent lot IDs (the DAG); child
  edges are stored too for traversal. Every token movement goes through one `_update` hook that
  enforces the ERC-3643-style freeze (non-Active lots cannot move by *any* path) and the
  registered-recipient rule, and records every holder of each lot. `createLot` rejects frozen
  parents and locks the producer's bond.
- **LiabilityBond** — neutral custody of collateral. Creating a lot locks
  `bondPerUnit × quantity` for `liabilityPeriod`; locked bond cannot be withdrawn. A recall slashes
  the root lot's lock into a per-recall escrow, which is paid pro-rata to downstream holders
  (rejected transfers are credited for later withdrawal; the last recipient absorbs rounding dust)
  or refunded if the attribution is overturned.
- **RecallEngine** — verifies the oracle's EIP-712 recall, **derives the at-fault actor from the
  graph** (the root lot's producer), quarantines descendants, slashes, opens the dispute, and
  settles. *This is where liability is keyed to topology.*
- **DisputeModule** — UMA-style challenge window; a single arbiter resolves challenges.

## Recall data flow

1. A lab result reaches the oracle service (lab UI, dApp, or simulated feed).
2. The oracle stores the certificate on IPFS and signs
   `Recall(rootLotId, maxNodes, certificateCID)` (eager) or
   `RecallMerkle(rootLotId, quarantineRoot, payoutRoot, totalWeight, certificateCID)` (Merkle).
3. Anyone submits the signed recall to `RecallEngine`. The contract sets
   `atFault = producerOf(rootLotId)`, marks the root `Recalled`, and quarantines the descendants
   (eager: on-chain BFS; Merkle: lazily, one permissionless proof per lot).
4. The bond the producer locked for the root lot is slashed into escrow.
5. The accused may challenge within the window (evidence CID on IPFS); the arbiter upholds or
   overturns. Unchallenged recalls auto-uphold when the window closes.
6. Settlement. Upheld eager recalls: `finalizeRecall` computes the payout table **on-chain**
   (one entry per affected lot × holder with a non-zero balance, excluding the at-fault actor)
   and pays pro-rata by units held. Upheld Merkle recalls: each holder's entry is claimed by
   proof (anyone may submit; the share always goes to the holder). Overturned: escrow refunded.

## Design decisions

- **Fault by position, not by assertion.** The oracle names only the defective lot; the contract
  decides who pays. A defect introduced mid-chain is recalled at that tier's lot, which slashes
  that tier's producer and leaves upstream and sibling lots untouched. If the oracle picks the
  wrong root, the accused challenges, the arbiter overturns (refund), and the oracle re-issues the
  recall on the true upstream lot.
- **Per-lot locks close the withdrawal escape.** Collateral backing a lot stays locked for the
  liability period, so an actor cannot withdraw just before a recall lands. After the period the
  lock can be released (by anyone); a later recall falls back to the producer's free bond.
- **No caller-supplied payout data.** Earlier drafts let the finalizer pass `holders/weights`;
  anyone could have redirected the escrow. Eager payouts are now derived from chain state, and the
  Merkle payout table is signed by the oracle.
- **Stable affected set.** The eager path stores only `maxNodes` and recomputes the affected set
  at finalize: it cannot change in between because every affected lot is frozen and `createLot`
  rejects frozen parents. This saves one storage write per affected lot at initiation.
- **Two recall modes.** Eager initiation grows with the affected set (O(n) writes plus an O(n²)
  dedup in the view-only BFS). The Merkle path's initiation is O(1) and per-lot work is
  O(log n) and pull-based — see [`merkle_results.md`](merkle_results.md) and
  [`benchmark_results.md`](benchmark_results.md).

## Trust assumptions and limitations

- **Oracle.** The lab/regulator key is trusted to report results honestly and, in Merkle mode, to
  compute the affected set and payout table correctly (the contract does not re-derive them).
  Signatures bind the certificate CID, so every recall is auditable against its evidence.
- **Arbiter.** A single trusted arbiter resolves challenges. A production system would replace it
  with an optimistic-oracle vote or a committee (the DisputeModule interface allows that swap).
- **Lot data.** Producers declare their own parent edges and quantities. Under-declaring parents
  hides lineage; the bond lock makes over-production costly but cannot detect false lineage.
- **Attribution depth.** Only the root lot's producer is slashed. Shared liability across several
  upstream contributors (for example, pro-rata by input share) is future work.
- **Rounding.** Eager payouts pay the full pot. Merkle claims floor each share, leaving at most
  (number of entries − 1) wei in escrow.
- **Custodian field.** `Lot.custodian` is the most recent recipient. Payouts use the full holder
  set and balances, not this field.

## Prior art (and our delta)

See [`prior_art.md`](prior_art.md). In short: provenance DAGs (Westerkamp et al.), bonded
optimistic oracles (UMA), token-freeze standards (ERC-3643) and parametric payouts exist
separately. RecallMesh's contribution is tying **slashing and pro-rata compensation to the
provenance graph's topology**.
