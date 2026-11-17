# RecallMesh — Comparison with Prior Art

This table supports the final report's related-work section. It concedes what each prior system
already does and limits RecallMesh's novelty claim to the combination in the last row: liability
that is **collateralized and keyed to the provenance graph's topology**.

| System | Provenance DAG | Recall: affected set from lineage | Freeze / quarantine | Collateral at stake | Fault attribution | Downstream compensation | Dispute before settlement |
|---|---|---|---|---|---|---|---|
| Westerkamp et al., token recipes [1] | Yes. Child lots consume parent-lot tokens. | No. Provenance only. | No | No | No | No | No |
| UMA Optimistic Oracle [2] | No | No | No | Yes. Proposer/disputer bonds. | Of an *assertion*, not of a supply-chain actor | Bond goes to the correct party | Yes. Challenge window and slashing. |
| ERC-3643 (T-REX) [3] | No | No | Yes. Freeze, partial freeze, forced transfer. | No | No | No | No |
| Parametric insurance | No | No | No | Premium pool | Not needed. Payout is triggered by an index/oracle. | Yes, automatic. Subject to basis risk. | Usually none |
| Anaka, vehicle recall management [4] | Tracking of parts and vehicles | Identifies affected vehicles | No | No | No | No | No |
| **RecallMesh** | **Yes.** ERC-1155 lots with parent adjacency. | **Yes.** On-chain BFS (eager) or oracle-committed Merkle set. | **Yes.** ERC-3643-style. Enforced on every transfer path. | **Yes.** Bond locked per lot, sized to quantity. | **Yes. Derived on-chain:** the producer of the recalled root lot. | **Yes.** Pro-rata by quarantined units held, computed on-chain or claimed by proof. | **Yes.** UMA-style window, arbiter, refund on overturn. |

## What we reuse

- **Lineage model** from token recipes [1]: a lot's parents are the inputs consumed to make it.
- **Bond + challenge window + slash** pattern from optimistic oracles [2], applied to recall
  attribution rather than to arbitrary assertions.
- **Freeze semantics** from ERC-3643 [3]: quarantined lots cannot move, and the freeze is enforced
  in the token's single transfer hook.
- **Oracle-triggered automatic payout** from parametric insurance. Paying by units actually
  quarantined avoids most of the basis risk of index-based triggers.

## What is new

The same graph traversal that decides *which lots to quarantine* also decides *who pays*: the
producer at the root position. It also decides *who is paid*: the holders of every descendant lot,
weighted by quarantined quantity. The penalty is the collateral locked when that root lot was
produced. To our knowledge no prior system couples these three outcomes to the provenance graph.

## References

[1] M. Westerkamp, F. Victor, A. Küpper, "Blockchain-based supply chain traceability: Token recipes
model manufacturing processes," arXiv:1810.09843, 2018.
[2] UMA, "How does UMA's Optimistic Oracle work?" UMA Protocol Documentation.
[3] J. Lebrun et al., "ERC-3643: T-REX — Token for Regulated EXchanges," EIP-3643, 2021.
[4] R. E. Anaka, "Vehicle supply chain recall management and fraud prevention using blockchain,"
Preprints.org, 2024, doi:10.20944/preprints202402.0457.v1.
