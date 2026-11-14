import React, { useEffect, useState, useCallback } from "react";
import { ethers } from "ethers";
import ProvenanceGraph from "./components/ProvenanceGraph.jsx";
import deployments from "./deployments.json";
import { ABIS, ROLE, STATUS_COLOR, contract, signRecall, buildGraph, lotMetadataURI } from "./lib/contracts.js";

const MAX_NODES = 4096;
// read straight from the node: MetaMask caches eth_getLogs/latest block on local chains, so new lots may not show
const reader = new ethers.JsonRpcProvider(deployments.rpcUrl);
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");

export default function App() {
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState(null);
  const [lots, setLots] = useState([]);
  const [graph, setGraph] = useState({ nodes: [], edges: [] });
  const [bond, setBond] = useState("0");
  const [log, setLog] = useState([]);
  const [lastRecall, setLastRecall] = useState(null); // { id, root, atFault, affected:[], slashed, payouts:[] | null }

  // form state
  const [regAddr, setRegAddr] = useState("");
  const [regRole, setRegRole] = useState("1");
  const [regName, setRegName] = useState("");
  const [lotName, setLotName] = useState("");
  const [lotParents, setLotParents] = useState("");
  const [lotAmount, setLotAmount] = useState("100");
  const [stakeAmt, setStakeAmt] = useState("1");
  const [recallRoot, setRecallRoot] = useState("1");

  const configured = Boolean(deployments.LotRegistry);
  const say = (msg, kind = "") => setLog((l) => [{ msg, kind, t: Date.now() + Math.random() }, ...l].slice(0, 40));

  const connect = useCallback(async () => {
    try {
      if (!window.ethereum) {
        setChainId(Number((await reader.getNetwork()).chainId));
        return say("No wallet found — read-only view of " + deployments.rpcUrl);
      }
      // newer MetaMask picks the network per site; ask it to use the deployed chain before building the provider
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + deployments.chainId.toString(16) }] });
      const prov = new ethers.BrowserProvider(window.ethereum);
      await prov.send("eth_requestAccounts", []);
      const sgn = await prov.getSigner();
      const acct = await sgn.getAddress();
      const net = await prov.getNetwork();
      setSigner(sgn);
      setAccount(acct);
      setChainId(Number(net.chainId));
      say("Connected " + short(acct) + " on chain " + net.chainId, "ok");
    } catch (e) {
      say(e.shortMessage || e.message, "err");
    }
  }, []);

  // follow MetaMask account switches so the demo never signs with a stale account
  useEffect(() => {
    if (!window.ethereum?.on || !account) return;
    const onChange = () => connect();
    window.ethereum.on("accountsChanged", onChange);
    window.ethereum.on("chainChanged", onChange);
    return () => {
      window.ethereum.removeListener("accountsChanged", onChange);
      window.ethereum.removeListener("chainChanged", onChange);
    };
  }, [account, connect]);

  const refresh = useCallback(async () => {
    if (!configured) return;
    try {
      const lotReg = contract("LotRegistry", deployments.LotRegistry, reader);
      const actors = contract("ActorRegistry", deployments.ActorRegistry, reader);
      const created = await lotReg.queryFilter(lotReg.filters.LotCreated(), 0, "latest");
      const out = [];
      for (const ev of created) {
        const id = Number(ev.args.lotId);
        const lot = await lotReg.getLot(id);
        let role = 0;
        try { role = Number(await actors.roleOf(lot.producer)); } catch {}
        out.push({
          id,
          producer: lot.producer,
          custodian: lot.custodian,
          status: Number(lot.status),
          role,
          parents: lot.parents.map(Number),
          metadataURI: lot.metadataURI,
        });
      }
      out.sort((a, b) => a.id - b.id);
      setLots(out);
      setGraph(buildGraph(out));
      if (account) {
        const bondC = contract("LiabilityBond", deployments.LiabilityBond, reader);
        setBond(ethers.formatEther(await bondC.bondOf(account)));
      }
    } catch (e) {
      say(e.shortMessage || e.message, "err");
    }
  }, [account, configured]);

  useEffect(() => { refresh(); }, [refresh]);

  const tx = async (fn, label) => {
    if (!signer) return say("Connect a wallet first", "err");
    try {
      say(label + "…");
      const t = await fn();
      const rc = await t.wait();
      say(label + " ✓ (block " + rc.blockNumber + ")", "ok");
      await refresh();
      return rc;
    } catch (e) {
      say(label + " ✗ " + (e.shortMessage || e.reason || e.message), "err");
    }
  };

  const doRegister = () =>
    tx(() => contract("ActorRegistry", deployments.ActorRegistry, signer).registerActor(regAddr.trim(), Number(regRole), regName), "Register " + (regName || ROLE[regRole]));

  const doStake = () =>
    tx(() => contract("LiabilityBond", deployments.LiabilityBond, signer).stakeBond({ value: ethers.parseEther(stakeAmt || "0") }), "Stake " + stakeAmt + " ETH bond");

  const doCreateLot = () => {
    // validate here: BigInt() on text like "L1" would throw before tx() can report it
    if (!/^\s*(\d+\s*(,\s*\d+\s*)*)?$/.test(lotParents)) return say("Parents must be lot numbers like 1 or 1,3 (not L1)", "err");
    if (!/^\s*[1-9]\d*\s*$/.test(lotAmount)) return say("Amount must be a whole number above 0", "err");
    const parents = lotParents.split(",").map((s) => s.trim()).filter(Boolean).map((s) => BigInt(s));
    const label = "Create lot" + (lotName ? " \"" + lotName + "\"" : "");
    return tx(() => contract("LotRegistry", deployments.LotRegistry, signer).createLot(parents, BigInt(lotAmount.trim()), lotMetadataURI(lotName)), label).then((rc) => rc && setLotName(""));
  };

  const doRecall = async () => {
    if (!signer) return say("Connect a wallet first", "err");
    if (!/^\s*[1-9]\d*\s*$/.test(recallRoot)) return say("Root lot must be a lot number like 1", "err");
    try {
      const root = Number(recallRoot);
      const lotReg = contract("LotRegistry", deployments.LotRegistry, reader);
      const rootLot = await lotReg.getLot(root);
      if (rootLot.id === 0n) return say("Lot " + root + " does not exist", "err");
      const atFault = rootLot.producer;
      say("Regulator signs EIP-712 recall for L" + root + " (at-fault " + short(atFault) + ")");
      const sig = await signRecall(signer, deployments.RecallEngine, chainId, root, atFault, MAX_NODES);
      const engine = contract("RecallEngine", deployments.RecallEngine, signer);
      const bondC = contract("LiabilityBond", deployments.LiabilityBond, reader);
      const rc = await tx(() => engine.initiateRecall(root, atFault, MAX_NODES, sig), "Initiate recall on L" + root);
      if (!rc) return;
      let recallId = null;
      let slashed = 0n;
      for (const lg of rc.logs) {
        for (const c of [engine, bondC]) {
          try {
            const parsed = c.interface.parseLog(lg);
            if (parsed?.name === "RecallInitiated") recallId = Number(parsed.args.recallId);
            if (parsed?.name === "BondSlashed") slashed = parsed.args.amount;
          } catch {}
        }
      }
      const affected = (await lotReg.affectedDescendants(root, MAX_NODES)).map(Number);
      setLastRecall({ id: recallId, root, atFault, affected, slashed, payouts: null });
      say("Quarantined " + affected.length + " downstream lot(s); slashed " + ethers.formatEther(slashed) + " ETH", "ok");
    } catch (e) {
      say("Recall ✗ " + (e.shortMessage || e.reason || e.message), "err");
    }
  };

  const doFinalize = async () => {
    if (!signer || !lastRecall) return;
    try {
      // arbiter resolves (demo convenience), then pay downstream holders pro-rata to the units they hold.
      const disputes = contract("DisputeModule", deployments.DisputeModule, signer);
      await tx(() => disputes.resolveDispute(lastRecall.id, true), "Arbiter upholds recall");
      const lotReg = contract("LotRegistry", deployments.LotRegistry, reader);
      const weightByHolder = {};
      for (const id of lastRecall.affected) {
        const lot = await lotReg.getLot(id);
        const units = await lotReg.balanceOf(lot.custodian, id);
        weightByHolder[lot.custodian] = (weightByHolder[lot.custodian] || 0n) + units;
      }
      const holders = Object.keys(weightByHolder).filter((h) => weightByHolder[h] > 0n);
      if (!holders.length) return say("No downstream holders to pay", "err");
      const weights = holders.map((h) => weightByHolder[h]);
      const rc = await tx(() => contract("RecallEngine", deployments.RecallEngine, signer).finalizeRecall(lastRecall.id, holders, weights), "Pay out downstream holders");
      if (!rc) return;
      const total = weights.reduce((a, b) => a + b, 0n);
      // same integer formula as LiabilityBond.distributePayout
      const payouts = holders.map((h, i) => ({ holder: h, units: weights[i], amount: (lastRecall.slashed * weights[i]) / total }));
      setLastRecall((r) => ({ ...r, payouts }));
    } catch (e) {
      say("Payout ✗ " + (e.shortMessage || e.reason || e.message), "err");
    }
  };

  const roleOfAddr = (a) => ROLE[lots.find((l) => l.producer === a)?.role] || "holder";

  return (
    <div className="app">
      <div className="topbar">
        <h1>RecallMesh</h1>
        <span className="sub">provenance with topology-aware recall liability</span>
        <div className="spacer" />
        <span className="pill">{lots.length} lot(s) on chain {chainId ?? deployments.chainId}</span>
        {account ? <span className="pill strong">{short(account)} · bond {bond} ETH</span> : null}
        <button style={{ width: "auto" }} onClick={connect}>{account ? "Reconnect" : "Connect wallet"}</button>
      </div>

      {!configured && (
        <div className="banner">
          Contracts not configured. Run <code>npx hardhat node</code> then
          <code> npx hardhat run scripts/deploy.js --network localhost</code> (it writes addresses into
          <code> ui/src/deployments.json</code>), then refresh.
        </div>
      )}

      <div className="main">
        <div className="panel">
          <h2><span className="step">1</span>Register actor</h2>
          <small>Admin only. Lots can only be created by registered actors.</small>
          <input placeholder="0x… address" value={regAddr} onChange={(e) => setRegAddr(e.target.value)} />
          <select value={regRole} onChange={(e) => setRegRole(e.target.value)}>
            {ROLE.map((r, i) => (i ? <option key={i} value={i}>{r}</option> : null))}
          </select>
          <input placeholder="name, e.g. GreenField Farm" value={regName} onChange={(e) => setRegName(e.target.value)} />
          <button onClick={doRegister} disabled={!signer}>Register</button>

          <h2><span className="step">2</span>Stake bond</h2>
          <small>Collateral that is slashed if this actor's lot is recalled.</small>
          <input value={stakeAmt} onChange={(e) => setStakeAmt(e.target.value)} />
          <button onClick={doStake} disabled={!signer}>Stake (ETH)</button>

          <h2><span className="step">3</span>Create lot</h2>
          <small>Next lot will be <b>L{lots.length + 1}</b>.</small>
          <label>Product name</label>
          <input placeholder="e.g. Raw spinach" value={lotName} onChange={(e) => setLotName(e.target.value)} />
          <label>Parent lot numbers (empty = raw lot)</label>
          <input placeholder="e.g. 1 or 1,3" value={lotParents} onChange={(e) => setLotParents(e.target.value)} />
          <label>Units</label>
          <input placeholder="amount" value={lotAmount} onChange={(e) => setLotAmount(e.target.value)} />
          <button onClick={doCreateLot} disabled={!signer}>Create lot</button>
        </div>

        <div className="graph">
          <div className="legend">
            {["Active", "Quarantined", "Recalled"].map((s, i) => (
              <span key={s}><span className="dot" style={{ background: STATUS_COLOR[i] }} /> {s}</span>
            ))}
            <span className="spacer" />
            <button style={{ width: "auto" }} className="secondary" onClick={refresh}>Refresh graph</button>
          </div>
          <div style={{ height: "calc(100% - 40px)" }}>
            {lots.length ? (
              <ProvenanceGraph nodes={graph.nodes} edges={graph.edges} />
            ) : (
              <div className="empty">No lots yet. Create a raw lot (no parents) to start the provenance graph.</div>
            )}
          </div>
        </div>

        <div className="panel right">
          <h2><span className="step">4</span>Trigger recall</h2>
          <small>Root (defective) lot number. Its producer's bond is slashed.</small>
          <input value={recallRoot} onChange={(e) => setRecallRoot(e.target.value)} />
          <button className="danger" onClick={doRecall} disabled={!signer}>Sign &amp; initiate recall</button>

          <h2><span className="step">5</span>Resolve &amp; pay out</h2>
          <button className="secondary" onClick={doFinalize} disabled={!signer || !lastRecall || lastRecall.payouts}>Resolve &amp; pay out</button>

          {lastRecall && (
            <div className="result">
              <div className="result-title">Recall #{lastRecall.id} · root L{lastRecall.root}</div>
              <div>At fault: {short(lastRecall.atFault)}</div>
              <div>Quarantined: {lastRecall.affected.length ? lastRecall.affected.map((id) => "L" + id).join(", ") : "none"}</div>
              <div>Slashed into escrow: <b>{ethers.formatEther(lastRecall.slashed)} ETH</b></div>
              {lastRecall.payouts ? (
                <>
                  <div className="result-sub">Paid pro-rata to downstream holders</div>
                  {lastRecall.payouts.map((p) => (
                    <div key={p.holder} className="payout">
                      <span>{short(p.holder)} · {roleOfAddr(p.holder)} · {p.units.toString()} units</span>
                      <b>{Number(ethers.formatEther(p.amount)).toFixed(4)} ETH</b>
                    </div>
                  ))}
                </>
              ) : (
                <div className="result-sub">Dispute window open. Payout pending.</div>
              )}
            </div>
          )}

          <h2>Activity</h2>
          <div className="log">
            {log.map((l) => (
              <div key={l.t} className={l.kind}>{l.kind === "err" ? "✗ " : "· "}{l.msg}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
