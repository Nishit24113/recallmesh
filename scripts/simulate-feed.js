/**
 * Simulated lab / IoT feed. Stands in for real sensors and inspectors: posts a series of
 * readings to the oracle service. Passing readings just publish a certificate; the
 * failing one makes the oracle sign (and, with SUBMIT=1, submit) a recall.
 *
 *   node scripts/simulate-feed.js
 *
 * Env: ORACLE_URL (default http://127.0.0.1:8787), TARGET_LOT (default 1),
 *      PASS_LOTS (comma list, default "2,3"), MODE ("eager" | "merkle"), SUBMIT ("1" = oracle submits)
 */
const ORACLE_URL = process.env.ORACLE_URL || "http://127.0.0.1:8787";
const TARGET = Number(process.env.TARGET_LOT || 1);
const PASS = (process.env.PASS_LOTS || "2,3").split(",").map(Number).filter((n) => n && n !== TARGET);
const MODE = process.env.MODE === "merkle" ? "merkle" : "eager";
const SUBMIT = process.env.SUBMIT === "1";

async function post(body) {
  const res = await fetch(`${ORACLE_URL}/lab-results`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

async function main() {
  const health = await (await fetch(`${ORACLE_URL}/health`)).json();
  console.log(`Oracle ${health.oracle} on chain ${health.chainId}\n`);

  for (const lotId of PASS) {
    const r = await post({
      lotId,
      lab: "ColdChain IoT gateway",
      test: "Cold-chain temperature log",
      result: "pass",
      reading: { maxTempC: 3.8, limitC: 5 },
    });
    console.log(`L${lotId}: temperature within limits -> certificate ${r.certificate.uri}`);
  }

  const r = await post({
    lotId: TARGET,
    lab: "State Food Safety Lab",
    test: "Listeria monocytogenes PCR",
    result: "fail",
    reading: { cfuPerGram: 140, limit: 0 },
    notes: "Positive on 3 of 5 samples",
    mode: MODE,
    submit: SUBMIT,
  });
  console.log(`L${TARGET}: Listeria POSITIVE -> certificate ${r.certificate.uri}`);
  console.log(`  oracle signed a ${r.mode} recall${r.note ? ` (${r.note})` : ""}`);
  if (r.recallId) console.log(`  submitted: recall #${r.recallId} (tx ${r.txHash})`);
  else console.log(`  signature: ${r.signature}\n  params: ${JSON.stringify(r.params)}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
