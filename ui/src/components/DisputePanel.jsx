import React, { useState } from "react";
import deployments from "../deployments.json";
import { contract, MODE } from "../lib/contracts.js";
import { fmt, SYMBOL, isLocal, advanceTime, txUrl } from "../lib/chain.js";

const PAYOUT_EVENTS = new Set(["ClaimPaid", "PayoutCredited", "BondRefunded"]);

function left(seconds) {
  if (seconds <= 0) return "closed";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m left` : `${m}m ${seconds % 60}s left`;
}

/**
 * Lifecycle of one recall after initiation: the accused may challenge (evidence on IPFS),
 * the arbiter upholds or overturns, then settlement — on-chain pro-rata payout (eager),
 * per-holder proof claims (Merkle), or a refund if the attribution was overturned.
 */
export default function DisputePanel({ signer, account, data, tx, say, oracle, refresh, nameOf, selected, setSelected }) {
  const [evidence, setEvidence] = useState("");
  const [working, setWorking] = useState(false);
  const r = data.recalls.find((x) => x.id === selected);
  if (!data.recalls.length) return null;

  const me = account.toLowerCase();
  const d = r?.dispute;
  const isAccused = r && me && d.accused.toLowerCase() === me;
  const isArbiter = me && data.arbiter.toLowerCase() === me;
  const settled = r?.state === 3;
  const windowOpen = r && data.now <= d.deadline;

  let status = "";
  if (r) {
    if (settled) status = r.isUpheld ? "Settled — paid to downstream holders" : "Settled — slashed bond refunded to accused";
    else if (d.resolved) status = d.upheld ? "Upheld by arbiter" : "Overturned by arbiter";
    else if (d.challenged) status = "Challenged — awaiting arbiter";
    else if (windowOpen) status = `Challenge window open (${left(d.deadline - data.now)})`;
    else status = "Window closed unchallenged — auto-upheld";
    if (!settled && r.mode === 1 && r.isResolved && r.isUpheld) status += "; holders claim by proof";
  }

  const run = async (fn) => {
    setWorking(true);
    try {
      await fn();
    } catch (e) {
      say(e.shortMessage || e.reason || e.message, "err");
    } finally {
      setWorking(false);
    }
  };

  const engine = () => contract("RecallEngine", deployments.RecallEngine, signer);
  const disputes = () => contract("DisputeModule", deployments.DisputeModule, signer);

  const challenge = () =>
    run(async () => {
      if (!evidence.trim()) return say("Describe your evidence first", "err");
      const doc = await oracle.putJSON(
        { type: "RecallMesh/DisputeEvidence", recallId: r.id, statement: evidence.trim(), submittedBy: account, at: new Date().toISOString() },
        `dispute-${r.id}.json`
      );
      say(`Evidence on IPFS: ${doc.cid.slice(0, 18)}…`);
      const rc = await tx(() => disputes().submitChallenge(r.id, doc.uri), `Challenge recall #${r.id}`);
      if (rc) setEvidence("");
    });

  const resolve = (upheld) =>
    run(() => tx(() => disputes().resolveDispute(r.id, upheld), `Arbiter ${upheld ? "upholds" : "overturns"} recall #${r.id}`));

  const skip = () =>
    run(async () => {
      await advanceTime(d.deadline - data.now + 1);
      say("Advanced local chain time past the challenge window", "ok");
      await refresh();
    });

  const finalize = () => run(() => tx(() => engine().finalizeRecall(r.id), `Finalize recall #${r.id}`));

  const claimMine = () =>
    run(async () => {
      const { payouts } = await oracle.proofs(r.id, account);
      if (!payouts.length) return say("You have no payout entries in this recall", "err");
      for (const e of payouts) {
        await tx(() => engine().claimPayout(r.id, e.lotId, e.holder, e.weight, e.proof), `Claim payout for L${e.lotId}`);
      }
    });

  const claimAll = () =>
    run(async () => {
      say("Oracle relaying every holder's claim (shares go to the holders)…");
      const res = await oracle.claimAll(r.id);
      say(`Relayed ${res.paid.length} claim(s)`, "ok");
      await refresh();
    });

  const payouts = r ? data.events.filter((e) => PAYOUT_EVENTS.has(e.name) && Number(e.args.recallId) === r.id) : [];
  const canFinalize = r && !settled && r.isResolved && (!r.isUpheld || r.mode === 0);
  const merkleClaims = r && !settled && r.isResolved && r.isUpheld && r.mode === 1;

  return (
    <>
      <h2><span className="step">6</span>Dispute &amp; settlement</h2>
      <select value={selected ?? ""} onChange={(e) => setSelected(Number(e.target.value))}>
        {data.recalls.map((x) => (
          <option key={x.id} value={x.id}>
            Recall #{x.id} · root L{x.rootLotId} · {MODE[x.mode]}
          </option>
        ))}
      </select>
      {r && (
        <div className="result">
          <div className="result-title">
            Recall #{r.id} · root L{r.rootLotId} · {MODE[r.mode]}
          </div>
          <div>At fault (root producer): <b>{nameOf(r.atFaultActor)}</b></div>
          <div>Slashed into escrow: <b>{fmt(r.slashed)} {SYMBOL}</b> · left {fmt(r.escrow)}</div>
          <div>
            Lab certificate:{" "}
            <a href={oracle.ipfsUrl(r.certificateCID)} target="_blank" rel="noreferrer">
              {r.certificateCID.slice(0, 18)}…
            </a>
          </div>
          <div className="result-sub">{status}</div>

          {payouts.length > 0 && (
            <>
              <div className="result-sub">{payouts.some((p) => p.name === "BondRefunded") ? "Refund" : "Paid pro-rata (weight = units held)"}</div>
              {payouts.map((p) => (
                <div key={p.txHash + p.index} className="payout">
                  <span>
                    {nameOf(p.args.to ?? p.args.actor)}
                    {p.name === "PayoutCredited" ? " (credited)" : ""}
                  </span>
                  {txUrl(p.txHash) ? (
                    <a href={txUrl(p.txHash)} target="_blank" rel="noreferrer"><b>{fmt(p.args.amount)} {SYMBOL}</b></a>
                  ) : (
                    <b>{fmt(p.args.amount)} {SYMBOL}</b>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {r && isAccused && !d.challenged && windowOpen && !d.resolved && (
        <>
          <label>You are the accused — contest the attribution</label>
          <textarea
            rows={3}
            placeholder="e.g. Contamination entered after our lot shipped; temperature logs attached…"
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
          />
          <button className="secondary" onClick={challenge} disabled={working || !signer}>Submit challenge (evidence → IPFS)</button>
        </>
      )}

      {r && !settled && !d.resolved && (
        <div className="row">
          <button className="secondary" onClick={() => resolve(true)} disabled={working || !isArbiter} title={isArbiter ? "" : "Connect the arbiter account"}>
            Arbiter: uphold
          </button>
          <button className="secondary" onClick={() => resolve(false)} disabled={working || !isArbiter} title={isArbiter ? "" : "Connect the arbiter account"}>
            Arbiter: overturn
          </button>
        </div>
      )}
      {r && !settled && !d.resolved && !isArbiter && <small>Arbiter: {nameOf(data.arbiter)}</small>}

      {r && isLocal && windowOpen && !d.resolved && !settled && (
        <button className="secondary" onClick={skip} disabled={working}>Skip challenge window (local chain)</button>
      )}

      {canFinalize && (
        <button onClick={finalize} disabled={working || !signer}>
          {r.isUpheld ? "Finalize: pay downstream holders" : "Finalize: refund the accused"}
        </button>
      )}
      {merkleClaims && (
        <div className="row">
          <button onClick={claimMine} disabled={working || !signer}>Claim my payout</button>
          <button className="secondary" onClick={claimAll} disabled={working}>Relay all claims</button>
        </div>
      )}
    </>
  );
}
