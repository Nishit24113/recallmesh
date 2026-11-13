# RecallMesh — Eager vs. Merkle recall gas (84 affected lots, fan-out 4, depth 3)

| Path | Operation | Gas | Scales with affected-set size? |
|---|---|---|---|
| Eager (on-chain traversal) | initiateRecall (traverse + quarantine all) | 2164785 | yes, O(n) writes + O(n^2) dedup |
| Merkle-anchored | initiateRecallMerkle (commit roots) | 325827 | no, O(1) |
| Merkle-anchored | quarantineWithProof (per lot) | 72104 | no, O(log n) proof |
| Merkle-anchored | claimPayout (per holder, pull) | 98355 | no, O(log n) proof |

Eager initiation at 84 lots costs 2164785 gas and keeps growing with the graph (our earlier sweep hit the block-gas ceiling as the affected set scaled). The Merkle path moves that cost off-chain: initiation is constant at ~325827 gas regardless of size, and quarantine/payout become small per-lot proof checks that anyone can submit (pull-based, so no push-loop or reentrancy exposure).
