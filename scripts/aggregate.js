/**
 * Merge the per-config benchmark results (bench/results/result_*.json) into:
 *   - bench/results/summary.csv   (raw CSV for plotting/analysis)
 *   - docs/benchmark_results.md   (a committed Markdown table for the report)
 * Run after the benchmark jobs finish:  node scripts/aggregate.js
 */
const fs = require("fs");
const path = require("path");

const resultsDir = path.join(__dirname, "..", "bench", "results");
const files = fs.existsSync(resultsDir)
  ? fs.readdirSync(resultsDir).filter((f) => /^result_\d+\.json$/.test(f))
  : [];

if (files.length === 0) {
  console.error("No result_*.json files in bench/results/. Run scripts/benchmark.js first.");
  process.exit(1);
}

const rows = files
  .map((f) => JSON.parse(fs.readFileSync(path.join(resultsDir, f), "utf8")))
  .sort((a, b) => a.descendants - b.descendants);

const header = ["label", "fanout", "depth", "descendants", "traversalGas", "recallGas", "recallNote"];
const csv = [header.join(",")]
  .concat(rows.map((r) => header.map((h) => r[h]).join(",")))
  .join("\n");
fs.writeFileSync(path.join(resultsDir, "summary.csv"), csv + "\n");

const md = [
  "# RecallMesh — Gas / Scalability Benchmark Results",
  "",
  "Gas for the recall path as a function of provenance-DAG size. `recallGas` is the full",
  "`initiateRecall` (traversal + quarantine loop + slash + open dispute); `traversalGas` is the",
  "`affectedDescendants` view alone. Produced by `scripts/benchmark.js` + `scripts/aggregate.js`.",
  "",
  "| Config | Fanout | Depth | Descendants | Traversal gas | Recall gas | Note |",
  "|---|---|---|---|---|---|---|",
].concat(
  rows.map(
    (r) =>
      `| ${r.label} | ${r.fanout} | ${r.depth} | ${r.descendants} | ${r.traversalGas} | ${r.recallGas ?? "-"} | ${r.recallNote} |`
  )
);
const docsDir = path.join(__dirname, "..", "docs");
fs.mkdirSync(docsDir, { recursive: true });
fs.writeFileSync(path.join(docsDir, "benchmark_results.md"), md.join("\n") + "\n");

console.log(`Merged ${rows.length} configs -> bench/results/summary.csv and docs/benchmark_results.md`);
console.log(md.slice(6).join("\n"));
