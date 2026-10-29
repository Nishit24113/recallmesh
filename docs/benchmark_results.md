# RecallMesh — Gas / Scalability Benchmark Results

Gas for the recall path as a function of provenance-DAG size. `recallGas` is the full
`initiateRecall` (traversal + quarantine loop + slash + open dispute); `traversalGas` is the
`affectedDescendants` view alone. Produced by `scripts/benchmark.js` + `scripts/aggregate.js`.

| Config | Fanout | Depth | Descendants | Traversal gas | Recall gas | Note |
|---|---|---|---|---|---|---|
| chain-d5 | 1 | 5 | 5 | 236494 | 524041 | ok |
| bin-d2 | 2 | 2 | 6 | 242669 | 540323 | ok |
| chain-d10 | 1 | 10 | 10 | 268520 | 606599 | ok |
| tri-d2 | 3 | 2 | 12 | 282136 | 640428 | ok |
| bin-d3 | 2 | 3 | 14 | 296211 | 674716 | ok |
| chain-d20 | 1 | 20 | 20 | 341198 | 780342 | ok |
| quad-d2 | 4 | 2 | 20 | 341198 | 780342 | ok |
| bin-d4 | 2 | 4 | 30 | 425378 | 965588 | ok |
| tri-d3 | 3 | 3 | 39 | 510973 | 1142143 | ok |
| quad-d3 | 4 | 3 | 84 | 1078695 | 2164689 | ok |
