import React, { useEffect, useState, useCallback } from "react";
import { ethers } from "ethers";
import ProvenanceGraph from "./components/ProvenanceGraph.jsx";
import deployments from "./deployments.json";
import { ABIS, ROLE, STATUS_COLOR, contract, signRecall, buildGraph } from "./lib/contracts.js";

const MAX_NODES = 4096;

export default function App() {
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState(null);
  const [lots, setLots] = useState([]);
  const [graph, setGraph] = useState({ nodes: [], edges: [] });
  const [bond, setBond] = useState("0");
  const [log, setLog] = useState([]);
  const [lastRecall, setLastRecall] = useState(null); // { id, root, affected:[] }

  // form state
  const [regAddr, setRegAddr] = useState("");
  const [regRole, setRegRole] = useState("1");
  const [regName, setRegName] = useState("");
  const [lotParents, setLotParents] = useState("");
  const [lotAmount, setLotAmount] = useState("100");
  const [stakeAmt, setStakeAmt] = useState("1");
  const [recallRoot, setRecallRoot] = useState("1");

  const configured = Boolean(deployments.LotRegistry);
  const say = (msg, err = false) => setLog((l) => [{ msg, err, t: Date.now() }, ...l].slice(0, 40));

  const connect = useCallback(async () => {
    try {
      let prov, sgn, acct;
      if (window.ethereum) {
        prov = new ethers.BrowserProvider(window.ethereum);
        await prov.send("eth_requestAccounts", []);
        sgn = await prov.getSigner();
        acct = await sgn.getAddress();
      } else {
        prov = new ethers.JsonRpcProvider(deployments.rpcUrl);
        say("No wallet found — connected read-only to " + deployments.rpcUrl);
      }
      const net = await prov.getNetwork();
      setProvider(prov);
      setSigner(sgn || null);
      setAccount(acct || "");
      setChainId(Number(net.chainId));
      say((sgn ? "Connected " + acct.slice(0, 8) + "…" : "Read-only") + " on chain " + net.chainId);
    } catch (e) {
      say(e.shortMessage || e.message, true);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!provider || !configured) return;
    try {
      const lotReg = contract("LotRegistry", deployments.LotRegistry, provider);
      const actors = contract("ActorRegistry", deployments.ActorRegistry, provider);
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
        });
      }
      out.sort((a, b) => a.id - b.id);
      setLots(out);
      setGraph(buildGraph(out));
      if (signer && account) {
        const bondC = contract("LiabilityBond", deployments.LiabilityBond, provider);
        setBond(ethers.formatEther(await bondC.bondOf(account)));
      }
    } catch (e) {
      say(e.shortMessage || e.message, true);
    }
  }, [provider, signer, account, configured]);

  useEffect(() => { refresh(); }, [refresh]);

  const tx = async (fn, label) => {
    if (!signer) return say("Connect a wallet first", true);
    try {
      say(label + "…");
      const t = await fn();
      const rc = await t.wait();
      say(label + " ✓ (block " + rc.blockNumber + ")");
      await refresh();
      return rc;
    } catch (e) {
      say(label + " ✗ " + (e.shortMessage || e.reason || e.message), true);
    }
  };

  const doRegister = () =>
    tx(() => contract("ActorRegistry", deployments.ActorRegistry, signer).registerActor(regAddr, Number(regRole), regName), "Register actor");

  const doStake = () =>
    tx(() => contract("LiabilityBond", deployments.LiabilityBond, signer).stakeBond({ value: ethers.parseEther(stakeAmt || "0") }), "Stake bond");

  const doCreateLot = () => {
    const parents = lotParents.split(",").map((s) => s.trim()).filter(Boolean).map((s) => BigInt(s));
    return tx(() => contract("LotRegistry", deployments.LotRegistry, signer).createLot(parents, BigInt(lotAmount || "1"), "ipfs://demo"), "Create lot");
  };

  const doRecall = async () => {
    if (!signer) return say("Connect a wallet first", true);
    try {
      const root = Number(recallRoot);
      const lotReg = contract("LotRegistry", deployments.LotRegistry, provider);
      const rootLot = await lotReg.getLot(root);
      const atFault = rootLot.producer;
      say("Signing EIP-712 recall for L" + root + " (at-fault " + atFault.slice(0, 8) + "…)");
      const sig = await signRecall(signer, deployments.RecallEngine, chainId, root, atFault, MAX_NODES);
      const engine = contract("RecallEngine", deployments.RecallEngine, signer);
      const rc = await tx(() => engine.initiateRecall(root, atFault, MAX_NODES, sig), "Initiate recall");
      // capture recallId + affected set
      let recallId = null;
      for (const lg of rc?.logs || []) {
        try {
          const parsed = engine.interface.parseLog(lg);
          if (parsed && parsed.name === "RecallInitiated") recallId = Number(parsed.args.recallId);
        } catch {}
      }
      const affected = (await lotReg.affectedDescendants(root, MAX_NODES)).map(Number);
      setLastRecall({ id: recallId, root, affected });
      say("Quarantined " + affected.length + " descendant lot(s). Recall id " + recallId);
    } catch (e) {
      say("Recall ✗ " + (e.shortMessage || e.reason || e.message), true);
    }
  };

  const doFinalize = async () => {
    if (!signer || !lastRecall) return;
    try {
      // arbiter resolves (demo convenience), then pay downstream holders pro-rata.
      const disputes = contract("DisputeModule", deployments.DisputeModule, signer);
      await tx(() => disputes.resolveDispute(lastRecall.id, true), "Resolve dispute (arbiter)");
      const lotReg = contract("LotRegistry", deployments.LotRegistry, provider);
      const weightByHolder = {};
      for (const id of lastRecall.affected) {
        const lot = await lotReg.getLot(id);
        weightByHolder[lot.custodian] = (weightByHolder[lot.custodian] || 0) + 1;
      }
      const holders = Object.keys(weightByHolder);
      const weights = holders.map((h) => BigInt(weightByHolder[h]));
      await tx(() => contract("RecallEngine", deployments.RecallEngine, signer).finalizeRecall(lastRecall.id, holders, weights), "Finalize payout");
    } catch (e) {
      say("Finalize ✗ " + (e.shortMessage || e.reason || e.message), true);
    }
  };

  return (
    <div className="app">
      <div className="topbar">
        <h1>RecallMesh</h1>
        <span className="sub">provenance with topology-aware recall liability</span>
        <div className="spacer" />
        {account ? <span className="pill">{account.slice(0, 6)}…{account.slice(-4)} · bond {bond} ETH</span> : null}
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
          <h2>Register actor</h2>
          <input placeholder="0x… address" value={regAddr} onChange={(e) => setRegAddr(e.target.value)} />
          <select value={regRole} onChange={(e) => setRegRole(e.target.value)}>
            {ROLE.map((r, i) => (i ? <option key={i} value={i}>{r}</option> : null))}
          </select>
          <input placeholder="name" value={regName} onChange={(e) => setRegName(e.target.value)} />
          <button onClick={doRegister} disabled={!signer}>Register</button>

          <h2>Stake bond</h2>
          <input value={stakeAmt} onChange={(e) => setStakeAmt(e.target.value)} />
          <button onClick={doStake} disabled={!signer}>Stake (ETH)</button>

          <h2>Create lot</h2>
          <input placeholder="parent ids, e.g. 1,2" value={lotParents} onChange={(e) => setLotParents(e.target.value)} />
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
            <ProvenanceGraph nodes={graph.nodes} edges={graph.edges} />
          </div>
        </div>

        <div className="panel right">
          <h2>Trigger recall</h2>
          <small>Root (defect) lot id — its producer is slashed.</small>
          <input value={recallRoot} onChange={(e) => setRecallRoot(e.target.value)} />
          <button className="danger" onClick={doRecall} disabled={!signer}>Sign &amp; initiate recall</button>
          <button className="secondary" onClick={doFinalize} disabled={!signer || !lastRecall}>Resolve &amp; pay out</button>

          <h2>Activity</h2>
          <div className="log">
            {log.map((l) => (
              <div key={l.t + l.msg} className={l.err ? "err" : ""}>{l.err ? "✗ " : "· "}{l.msg}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
