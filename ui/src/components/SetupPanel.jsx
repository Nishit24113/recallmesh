import React, { useState } from "react";
import { ethers } from "ethers";
import deployments from "../deployments.json";
import { ROLE, contract } from "../lib/contracts.js";
import { fmt, SYMBOL } from "../lib/chain.js";

const isUint = (s) => /^\s*[1-9]\d*\s*$/.test(s);

/**
 * Left column: onboarding and production — register actors (admin), stake/withdraw bond,
 * create lots (metadata published to IPFS; bond locked per unit) and move custody.
 */
export default function SetupPanel({ signer, data, tx, say, oracle }) {
  const [regAddr, setRegAddr] = useState("");
  const [regRole, setRegRole] = useState("1");
  const [regName, setRegName] = useState("");
  const [stakeAmt, setStakeAmt] = useState("1");
  const [lotName, setLotName] = useState("");
  const [lotParents, setLotParents] = useState("");
  const [lotAmount, setLotAmount] = useState("100");
  const [lotUnit, setLotUnit] = useState("kg");
  const [xLot, setXLot] = useState("");
  const [xTo, setXTo] = useState("");
  const [xAmt, setXAmt] = useState("10");

  const c = (name) => contract(name, deployments[name], signer);
  const lockPreview = isUint(lotAmount) ? data.bondPerUnit * BigInt(lotAmount.trim()) : 0n;

  const doRegister = () => {
    if (!ethers.isAddress(regAddr.trim())) return say("Enter a valid 0x address", "err");
    return tx(() => c("ActorRegistry").registerActor(regAddr.trim(), Number(regRole), regName), "Register " + (regName || ROLE[regRole]));
  };

  const doStake = () => {
    let v;
    try {
      v = ethers.parseEther(stakeAmt || "0");
    } catch {
      return say("Stake must be a number", "err");
    }
    return tx(() => c("LiabilityBond").stakeBond({ value: v }), `Stake ${stakeAmt} ${SYMBOL} bond`);
  };

  const doWithdraw = () => {
    if (!data.me?.free) return say("No free bond to withdraw", "err");
    return tx(() => c("LiabilityBond").withdrawBond(data.me.free), `Withdraw ${fmt(data.me.free)} ${SYMBOL} free bond`);
  };

  const doCreateLot = async () => {
    // validate here: BigInt() on text like "L1" would throw before tx() can report it
    if (!/^\s*(\d+\s*(,\s*\d+\s*)*)?$/.test(lotParents)) return say("Parents must be lot numbers like 1 or 1,3 (not L1)", "err");
    if (!isUint(lotAmount)) return say("Units must be a whole number above 0", "err");
    if (data.me && data.me.free < lockPreview) {
      return say(`This lot locks ${fmt(lockPreview)} ${SYMBOL} but you have ${fmt(data.me.free)} free — stake more first`, "err");
    }
    const parents = lotParents.split(",").map((s) => s.trim()).filter(Boolean).map((s) => BigInt(s));
    const qty = BigInt(lotAmount.trim());
    let uri;
    try {
      const meta = await oracle.putJSON(
        { type: "RecallMesh/LotMetadata", name: lotName || "Unnamed lot", quantity: Number(qty), unit: lotUnit, producer: data.me?.name },
        "lot-metadata.json"
      );
      uri = meta.uri;
      say(`Lot metadata on IPFS: ${meta.cid.slice(0, 16)}…`);
    } catch (e) {
      uri = "ipfs://demo?name=" + encodeURIComponent(lotName);
      say(`IPFS upload failed (${e.message}); using an inline name instead`, "err");
    }
    const label = "Create lot" + (lotName ? ` "${lotName}"` : "");
    const rc = await tx(() => c("LotRegistry").createLot(parents, qty, uri), label);
    if (rc) setLotName("");
  };

  const doTransfer = () => {
    if (!isUint(xLot) || !isUint(xAmt)) return say("Lot and units must be whole numbers", "err");
    if (!ethers.isAddress(xTo.trim())) return say("Pick a recipient", "err");
    return tx(() => c("LotRegistry").transferCustody(BigInt(xLot), xTo.trim(), BigInt(xAmt)), `Move ${xAmt} units of L${xLot}`);
  };

  const actorList = Object.entries(data.names);

  return (
    <div className="panel">
      <h2><span className="step">1</span>Register actor</h2>
      <small>Admin only. Lots can only be created and held by registered actors.</small>
      <input placeholder="0x… address" value={regAddr} onChange={(e) => setRegAddr(e.target.value)} />
      <select value={regRole} onChange={(e) => setRegRole(e.target.value)}>
        {ROLE.map((r, i) => (i ? <option key={i} value={i}>{r}</option> : null))}
      </select>
      <input placeholder="name, e.g. GreenField Farm" value={regName} onChange={(e) => setRegName(e.target.value)} />
      <button onClick={doRegister} disabled={!signer}>Register</button>

      <h2><span className="step">2</span>Liability bond</h2>
      <small>
        Each lot you create locks <b>{fmt(data.bondPerUnit, 6)} {SYMBOL}/unit</b> of your bond for the liability period.
        The lock is slashed if that lot is recalled.
      </small>
      <div className="row">
        <input value={stakeAmt} onChange={(e) => setStakeAmt(e.target.value)} />
        <button className="fit" onClick={doStake} disabled={!signer}>Stake</button>
      </div>
      <button className="secondary" onClick={doWithdraw} disabled={!signer || !data.me?.free}>
        Withdraw free bond ({fmt(data.me?.free ?? 0n)} {SYMBOL})
      </button>

      <h2><span className="step">3</span>Create lot</h2>
      <small>Next lot will be <b>L{data.lots.length + 1}</b>. Metadata is published to IPFS; only the CID goes on-chain.</small>
      <label>Product name</label>
      <input placeholder="e.g. Raw spinach" value={lotName} onChange={(e) => setLotName(e.target.value)} />
      <label>Parent lot numbers (empty = raw lot)</label>
      <input placeholder="e.g. 1 or 1,3" value={lotParents} onChange={(e) => setLotParents(e.target.value)} />
      <label>Units</label>
      <div className="row">
        <input value={lotAmount} onChange={(e) => setLotAmount(e.target.value)} />
        <select className="fit" value={lotUnit} onChange={(e) => setLotUnit(e.target.value)}>
          {["kg", "bags", "packs", "cases", "pallets"].map((u) => <option key={u}>{u}</option>)}
        </select>
      </div>
      <small>Locks {fmt(lockPreview, 6)} {SYMBOL} of your bond.</small>
      <button onClick={doCreateLot} disabled={!signer}>Create lot</button>

      <h2><span className="step">4</span>Move custody</h2>
      <small>Ship units downstream. Quarantined lots cannot move.</small>
      <div className="row">
        <input placeholder="lot #" value={xLot} onChange={(e) => setXLot(e.target.value)} />
        <input placeholder="units" value={xAmt} onChange={(e) => setXAmt(e.target.value)} />
      </div>
      <select value={xTo} onChange={(e) => setXTo(e.target.value)}>
        <option value="">recipient…</option>
        {actorList.map(([a, n]) => (
          <option key={a} value={a}>{n.name} ({ROLE[n.role]})</option>
        ))}
      </select>
      <button className="secondary" onClick={doTransfer} disabled={!signer}>Transfer</button>
    </div>
  );
}
