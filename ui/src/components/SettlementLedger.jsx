import React, { useState } from "react";
import { fmt, SYMBOL, txUrl } from "../lib/chain.js";

const MONEY = new Set([
  "BondStaked", "BondWithdrawn", "BondLocked", "BondReleased", "BondSlashed", "BondRefunded",
  "ClaimPaid", "PayoutCredited", "ClaimableWithdrawn",
]);
const RECALL = new Set([
  "RecallInitiated", "RecallFinalized", "BondSlashed", "BondRefunded", "ClaimPaid", "PayoutCredited",
  "PayoutDistributed", "ChallengeSubmitted", "DisputeResolved", "LotQuarantinedMerkle", "LotsQuarantined", "PayoutClaimed",
]);
// Skip events that duplicate another row (e.g. PayoutClaimed mirrors ClaimPaid).
const HIDDEN = new Set(["DisputeOpened", "PayoutClaimed", "LotsQuarantined", "PayoutDistributed"]);

/** One ledger row: [kind, description, signed amount | null]. */
function describe(e, nameOf) {
  const a = e.args;
  const rid = a.recallId != null ? ` · recall #${a.recallId}` : "";
  switch (e.name) {
    case "BondStaked": return ["stake", `${nameOf(a.actor)} staked bond`, a.amount];
    case "BondWithdrawn": return ["stake", `${nameOf(a.actor)} withdrew bond`, -a.amount];
    case "BondLocked": return ["lock", `${nameOf(a.actor)} locked bond for L${a.lotId}`, a.amount];
    case "BondReleased": return ["lock", `${nameOf(a.actor)} released lock on L${a.lotId}`, a.amount];
    case "BondSlashed": return ["slash", `${nameOf(a.actor)} slashed into escrow${rid}`, -a.amount];
    case "BondRefunded": return ["refund", `Escrow refunded to ${nameOf(a.actor)}${rid}`, a.amount];
    case "ClaimPaid": return ["pay", `Paid ${nameOf(a.to)}${rid}`, a.amount];
    case "PayoutCredited": return ["pay", `Credited ${nameOf(a.to)} (transfer rejected)${rid}`, a.amount];
    case "ClaimableWithdrawn": return ["pay", `${nameOf(a.to)} withdrew credited payout`, a.amount];
    case "RecallInitiated": return ["recall", `Recall #${a.recallId} on L${a.rootLotId}; at fault ${nameOf(a.atFaultActor)}`, null];
    case "RecallFinalized": return ["recall", `Recall #${a.recallId} finalized`, null];
    case "LotQuarantinedMerkle": return ["recall", `L${a.lotId} quarantined by proof${rid}`, null];
    case "ChallengeSubmitted": return ["dispute", `${nameOf(a.accused)} challenged${rid}`, null];
    case "DisputeResolved": return ["dispute", `Arbiter ${a.upheld ? "upheld" : "overturned"}${rid}`, null];
    default: return ["other", e.name, null];
  }
}

/** Live, event-sourced ledger of every bond, escrow and payout movement. */
export default function SettlementLedger({ events, nameOf }) {
  const [filter, setFilter] = useState("recall");
  const rows = events.filter(
    (e) => !HIDDEN.has(e.name) && (filter === "all" || (filter === "money" ? MONEY : RECALL).has(e.name))
  );

  return (
    <div className="ledger">
      <div className="ledger-head">
        <span className="ledger-title">Settlement ledger</span>
        <div className="seg compact">
          {[["recall", "Recalls"], ["money", "Money"], ["all", "All"]].map(([k, label]) => (
            <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="ledger-body">
        {rows.length === 0 ? (
          <div className="empty small">No events yet.</div>
        ) : (
          <table>
            <tbody>
              {rows.map((e) => {
                const [kind, text, amount] = describe(e, nameOf);
                const url = txUrl(e.txHash);
                return (
                  <tr key={e.txHash + e.index}>
                    <td className="blk">
                      {url ? <a href={url} target="_blank" rel="noreferrer">#{e.blockNumber}</a> : `#${e.blockNumber}`}
                    </td>
                    <td><span className={"tag " + kind}>{kind}</span></td>
                    <td className="desc">{text}</td>
                    <td className={"amt " + (amount == null ? "" : amount < 0n ? "neg" : "pos")}>
                      {amount == null ? "" : `${amount < 0n ? "−" : "+"}${fmt(amount < 0n ? -amount : amount)} ${SYMBOL}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
