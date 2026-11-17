# RecallMesh — Gas / Scalability Benchmark Results

Gas for the eager recall path as a function of provenance-DAG size. `recallGas` is the full
`initiateRecall` (traversal + quarantine loop + slash + open dispute); `traversalGas` is the
`affectedDescendants` view alone; `finalizeGas` is `finalizeRecall`, which computes the pro-rata
payout table on-chain from ERC-1155 balances and pays one entry per affected lot.
Produced by `scripts/benchmark.js` + `scripts/aggregate.js`.

| Config | Fanout | Depth | Descendants | Traversal gas | Recall gas | Finalize gas | Note |
|---|---|---|---|---|---|---|---|
| chain-d5 | 1 | 5 | 5 | 236517 | 586712 | 392801 | ok |
| bin-d2 | 2 | 2 | 6 | 242692 | 604250 | 420511 | ok |
| chain-d10 | 1 | 10 | 10 | 268543 | 675551 | 532516 | ok |
| tri-d2 | 3 | 2 | 12 | 282159 | 711893 | 589216 | ok |
| bin-d3 | 2 | 3 | 14 | 296234 | 748693 | 646381 | ok |
| chain-d20 | 1 | 20 | 20 | 341221 | 861858 | 820667 | ok |
| quad-d2 | 4 | 2 | 20 | 341221 | 861858 | 820667 | ok |
| bin-d4 | 2 | 4 | 30 | 425401 | 1059671 | 1120447 | ok |
| tri-d3 | 3 | 3 | 39 | 510996 | 1247538 | 1400190 | ok |
| quad-d3 | 4 | 3 | 84 | 1078718 | 2326665 | 2940190 | ok |
