# RecallMesh — Eager vs. Merkle recall gas (84 affected lots, fan-out 4, depth 3)

| Path | Operation | Gas | Scales with affected-set size? |
|---|---|---|---|
| Eager (on-chain traversal) | initiateRecall (traverse + quarantine all) | 2326665 | yes, O(n) writes + O(n^2) dedup |
| Eager (on-chain traversal) | finalizeRecall (on-chain payout table + 84 transfers) | 2940190 | yes, O(n) |
| Merkle-anchored | initiateRecallMerkle (commit roots) | 359656 | no, O(1) |
| Merkle-anchored | quarantineWithProof (per lot) | 75600 | no, O(log n) proof |
| Merkle-anchored | claimPayout (per holder, pull) | 102706 | no, O(log n) proof |

Eager initiation at 84 lots costs 2326665 gas and settlement another 2940190; both keep growing with the graph and eventually hit the block-gas ceiling. The Merkle path moves that cost off-chain: initiation is constant at ~359656 gas regardless of size, and quarantine/payout become small per-lot proof checks that anyone can submit (pull-based, so no push loop).
