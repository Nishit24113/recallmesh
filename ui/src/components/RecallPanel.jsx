import React, { useState } from "react";
import deployments from "../deployments.json";
import { contract } from "../lib/contracts.js";
import { reader } from "../lib/chain.js";

const TESTS = [
  { test: "Listeria monocytogenes PCR", lab: "State Food Safety Lab", fail: { cfuPerGram: 140, limit: 0 }, pass: { cfuPerGram: 0, limit: 0 } },
  { test: "Salmonella enrichment culture", lab: "State Food Safety Lab", fail: { detectedIn25g: true }, pass: { detectedIn25g: false } },
  { test: "Cold-chain temperature log", lab: "ColdChain IoT gateway", fail: { maxTempC: 11.2, limitC: 5 }, pass: { maxTempC: 3.8, limitC: 5 } },
  { test: "Foreign material X-ray", lab: "Plant QA inspection", fail: { fragmentsMm: [4.1] }, pass: { fragmentsMm: [] } },
];

/**
 * Report a lab result to the oracle. A failing result comes back as an oracle-signed
 * EIP-712 recall bound to the certificate CID; the connected wallet submits it (anyone
 * may). The at-fault actor is not chosen here: the contract derives it from the DAG.
 */
export default function RecallPanel({ signer, data, tx, say, oracle, animate, refresh, onRecall, nameOf, busy }) {
  const [lotId, setLotId] = useState("1");
  const [testIdx, setTestIdx] = useState(0);
  const [result, setResult] = useState("fail");
  const [mode, setMode] = useState("eager");
  const [working, setWorking] = useState(false);
  const [last, setLast] = useState(null);

  const lot = data.lots.find((l) => l.id === Number(lotId));

  const run = async () => {
    if (!lot) return say(`Lot ${lotId} does not exist`, "err");
    const t = TESTS[testIdx];
    setWorking(true);
    busy.current = true;
    try {
      say(`Lab reports "${t.test}" = ${result.toUpperCase()} for L${lot.id}`);
      const r = await oracle.labResult({
        lotId: lot.id,
        lab: t.lab,
        test: t.test,
        result,
        reading: t[result],
        mode,
        submit: !signer, // no wallet: let the oracle submit its own signed recall
      });
      setLast(r);
      say(`Certificate on IPFS: ${r.certificate.cid.slice(0, 18)}…`, "ok");
      if (!r.recall) return say("Result passed — no recall", "ok");
      if (r.note) say(r.note);

      let recallId = r.recallId;
      if (!recallId) {
        const engine = contract("RecallEngine", deployments.RecallEngine, signer);
        const p = r.params;
        const rc = await tx(
          () =>
            r.mode === "eager"
              ? engine.initiateRecall(p.rootLotId, p.maxNodes, p.certificateCID, r.signature)
              : engine.initiateRecallMerkle(p.rootLotId, p.quarantineRoot, p.payoutRoot, p.totalWeight, p.certificateCID, r.signature),
          `Submit oracle-signed ${r.mode} recall of L${lot.id}`
        );
        if (!rc) return;
        for (const lg of rc.logs) {
          try {
            const parsed = engine.interface.parseLog(lg);
            if (parsed?.name === "RecallInitiated") recallId = Number(parsed.args.recallId);
          } catch {}
        }
      }
      onRecall(recallId);

      let affected;
      if (r.mode === "eager") {
        affected = (await contract("RecallEngine", deployments.RecallEngine, reader).affectedOf(recallId)).map(Number);
      } else {
        say("Relaying Merkle quarantine proofs via the oracle…");
        const q = await oracle.quarantineAll(recallId);
        affected = q.quarantined;
      }
      await refresh();
      say(`Recall #${recallId}: ${affected.length} downstream lot(s) quarantined; fault attributed to ${nameOf(lot.producer)}`, "ok");
      await animate(lot.id, affected);
    } catch (e) {
      say("Recall ✗ " + (e.shortMessage || e.reason || e.message), "err");
    } finally {
      busy.current = false;
      setWorking(false);
    }
  };

  return (
    <>
      <h2><span className="step">5</span>Lab result → recall</h2>
      <small>
        The oracle publishes the certificate to IPFS and, on a failure, signs a recall bound to its CID. The at-fault
        actor is derived on-chain: the producer of the root lot.
      </small>
      <div className="row">
        <div className="grow">
          <label>Root lot</label>
          <select value={lotId} onChange={(e) => setLotId(e.target.value)}>
            {data.lots.map((l) => (
              <option key={l.id} value={l.id} disabled={l.status === 2}>
                L{l.id}{l.name ? ` · ${l.name}` : ""}{l.status === 2 ? " (recalled)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Result</label>
          <select value={result} onChange={(e) => setResult(e.target.value)}>
            <option value="fail">Fail</option>
            <option value="pass">Pass</option>
          </select>
        </div>
      </div>
      <label>Test</label>
      <select value={testIdx} onChange={(e) => setTestIdx(Number(e.target.value))}>
        {TESTS.map((t, i) => <option key={t.test} value={i}>{t.test}</option>)}
      </select>
      <label>Recall mode</label>
      <div className="seg">
        <button className={mode === "eager" ? "on" : ""} onClick={() => setMode("eager")}>Eager (on-chain BFS)</button>
        <button className={mode === "merkle" ? "on" : ""} onClick={() => setMode("merkle")}>Merkle (O(1) init)</button>
      </div>
      {lot && result === "fail" && (
        <small>
          At fault by graph position: <b>{nameOf(lot.producer)}</b>. The bond it locked when creating L{lot.id} is
          slashed into escrow.
        </small>
      )}
      <button className={result === "fail" ? "danger" : ""} onClick={run} disabled={working || !lot}>
        {working ? "Working…" : result === "fail" ? "Report failure & recall" : "Report passing result"}
      </button>
      {last?.certificate && (
        <div className="cert">
          Certificate:{" "}
          <a href={oracle.ipfsUrl(last.certificate.cid)} target="_blank" rel="noreferrer">
            {last.certificate.cid.slice(0, 22)}…
          </a>
        </div>
      )}
    </>
  );
}
