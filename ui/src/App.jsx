import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { ethers } from "ethers";
import ProvenanceGraph from "./components/ProvenanceGraph.jsx";
import SetupPanel from "./components/SetupPanel.jsx";
import RecallPanel from "./components/RecallPanel.jsx";
import DisputePanel from "./components/DisputePanel.jsx";
import SettlementLedger from "./components/SettlementLedger.jsx";
import deployments from "./deployments.json";
import { ROLE, STATUS_COLOR, contract, short, legacyName, buildGraph, propagationLayers } from "./lib/contracts.js";
import { reader, allEvents, fmt, SYMBOL, ORACLE_URL, sleep } from "./lib/chain.js";
import { oracleClient, lotMetadata } from "./lib/oracle.js";

const oracle = oracleClient(ORACLE_URL);
const configured = Boolean(deployments.LotRegistry);
const C = configured
  ? {
      actors: contract("ActorRegistry", deployments.ActorRegistry, reader),
      lots: contract("LotRegistry", deployments.LotRegistry, reader),
      bond: contract("LiabilityBond", deployments.LiabilityBond, reader),
      disputes: contract("DisputeModule", deployments.DisputeModule, reader),
      engine: contract("RecallEngine", deployments.RecallEngine, reader),
    }
  : null;

const EMPTY = { lots: [], names: {}, recalls: [], events: [], me: null, bondPerUnit: 0n, arbiter: "", now: 0 };

export default function App() {
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState("");
  const [data, setData] = useState(EMPTY);
  const [display, setDisplay] = useState({}); // lotId -> status override while animating
  const [selected, setSelected] = useState(null); // recall id
  const [log, setLog] = useState([]);
  const [oracleOk, setOracleOk] = useState(null);
  const busy = useRef(false);

  const say = useCallback(
    (msg, kind = "") => setLog((l) => [{ msg, kind, t: Date.now() + Math.random() }, ...l].slice(0, 40)),
    []
  );

  const connect = useCallback(async () => {
    try {
      if (!window.ethereum) return say("No wallet found — read-only view of " + deployments.rpcUrl);
      // newer MetaMask picks the network per site; ask it to use the deployed chain first
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + Number(deployments.chainId).toString(16) }],
      });
      const prov = new ethers.BrowserProvider(window.ethereum);
      await prov.send("eth_requestAccounts", []);
      const sgn = await prov.getSigner();
      const acct = await sgn.getAddress();
      setSigner(sgn);
      setAccount(acct);
      say("Connected " + short(acct), "ok");
    } catch (e) {
      say(e.shortMessage || e.message, "err");
    }
  }, [say]);

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
      const [count, recallCount, bondPerUnit, arbiter, block, actorEvents, bondEvents, engineEvents, disputeEvents] =
        await Promise.all([
          C.lots.lotCount(),
          C.engine.recallCount(),
          C.bond.bondPerUnit(),
          C.disputes.arbiter(),
          reader.getBlock("latest"),
          allEvents(C.actors),
          allEvents(C.bond),
          allEvents(C.engine),
          allEvents(C.disputes),
        ]);

      const names = {};
      for (const ev of actorEvents) {
        if (ev.eventName === "ActorRegistered") {
          names[ev.args.actor.toLowerCase()] = { name: ev.args.name, role: Number(ev.args.role) };
        }
      }

      const lots = await Promise.all(
        Array.from({ length: Number(count) }, (_, i) => i + 1).map(async (id) => {
          const l = await C.lots.getLot(id);
          const meta = await lotMetadata(oracle, l.metadataURI);
          const who = names[l.producer.toLowerCase()];
          return {
            id,
            producer: l.producer,
            custodian: l.custodian,
            status: Number(l.status),
            parents: l.parents.map(Number),
            metadataURI: l.metadataURI,
            role: who?.role ?? 0,
            producerName: who?.name,
            name: meta?.name || legacyName(l.metadataURI),
            unit: meta?.unit,
          };
        })
      );

      const recalls = await Promise.all(
        Array.from({ length: Number(recallCount) }, (_, i) => i + 1).map(async (id) => {
          const [r, d, resolved, upheld, escrow] = await Promise.all([
            C.engine.getRecall(id),
            C.disputes.getDispute(id),
            C.disputes.isResolved(id),
            C.disputes.isUpheld(id),
            C.bond.escrowOf(id),
          ]);
          return {
            id,
            rootLotId: Number(r.rootLotId),
            atFaultActor: r.atFaultActor,
            state: Number(r.state),
            mode: Number(r.mode),
            initiatedAt: Number(r.initiatedAt),
            slashed: r.slashed,
            certificateCID: r.certificateCID,
            dispute: {
              accused: d.accused,
              deadline: Number(d.deadline),
              challenged: d.challenged,
              resolved: d.resolved,
              upheld: d.upheld,
            },
            isResolved: resolved,
            isUpheld: upheld,
            escrow,
          };
        })
      );

      const tag = (src) => (ev) => ({
        src,
        name: ev.eventName,
        args: ev.args,
        blockNumber: ev.blockNumber,
        index: ev.index,
        txHash: ev.transactionHash,
      });
      const events = [
        ...bondEvents.map(tag("bond")),
        ...engineEvents.map(tag("engine")),
        ...disputeEvents.map(tag("dispute")),
      ]
        .filter((e) => e.name)
        .sort((a, b) => b.blockNumber - a.blockNumber || b.index - a.index);

      let me = null;
      if (account) {
        const [free, locked, claimable] = await Promise.all([
          C.bond.bondOf(account),
          C.bond.lockedOf(account),
          C.bond.claimableOf(account),
        ]);
        me = { free, locked, claimable, ...names[account.toLowerCase()] };
      }

      setData({ lots, names, recalls, events, me, bondPerUnit, arbiter, now: Number(block.timestamp) });
      setSelected((s) => s ?? (recalls.length ? recalls[recalls.length - 1].id : null));
    } catch (e) {
      say("Refresh ✗ " + (e.shortMessage || e.message), "err");
    }
  }, [account, say]);

  useEffect(() => {
    refresh();
    oracle.health().then(() => setOracleOk(true), () => setOracleOk(false));
  }, [refresh]);

  // live updates: poll the chain (cheap on a local node; slower on a public testnet)
  useEffect(() => {
    const ms = Number(deployments.chainId) === 31337 ? 4000 : 15000;
    const h = setInterval(() => !busy.current && document.visibilityState === "visible" && refresh(), ms);
    return () => clearInterval(h);
  }, [refresh]);

  const tx = useCallback(
    async (fn, label) => {
      if (!signer) return say("Connect a wallet first", "err");
      busy.current = true;
      try {
        say(label + "…");
        const t = await fn();
        const rc = await t.wait();
        say(label + " ✓ (block " + rc.blockNumber + ")", "ok");
        await refresh();
        return rc;
      } catch (e) {
        say(label + " ✗ " + (e.shortMessage || e.reason || e.message), "err");
      } finally {
        busy.current = false;
      }
    },
    [signer, refresh, say]
  );

  /** Replay a recall as a wave through the DAG: root first, then each descendant layer. */
  const animate = useCallback(async (root, affected) => {
    const layers = propagationLayers(data.lots, root, affected);
    const ov = {};
    layers.flat().forEach((id) => (ov[id] = 0));
    setDisplay({ ...ov });
    for (let i = 0; i < layers.length; i++) {
      await sleep(i === 0 ? 250 : 550);
      layers[i].forEach((id) => (ov[id] = i === 0 ? 2 : 1));
      setDisplay({ ...ov });
    }
    await sleep(700);
    setDisplay({});
  }, [data.lots]);

  const nameOf = useCallback(
    (a) => {
      if (!a) return "";
      const n = data.names[a.toLowerCase()];
      return n ? n.name : short(a);
    },
    [data.names]
  );

  const roots = useMemo(() => new Set(data.recalls.map((r) => r.rootLotId)), [data.recalls]);
  const graph = useMemo(() => buildGraph(data.lots, display, roots), [data.lots, display, roots]);
  const ctx = { signer, account, data, tx, say, refresh, animate, nameOf, oracle, oracleOk, contracts: C, busy };

  return (
    <div className="app">
      <div className="topbar">
        <h1>RecallMesh</h1>
        <span className="sub">provenance with topology-aware recall liability</span>
        <div className="spacer" />
        <span className={"pill " + (oracleOk ? "ok" : oracleOk === false ? "bad" : "")} title={oracle.url}>
          oracle {oracleOk ? "online" : oracleOk === false ? "offline" : "…"}
        </span>
        <span className="pill">
          {data.lots.length} lots · chain {deployments.chainId}
        </span>
        {data.me && (
          <span className="pill strong" title={account}>
            {data.me.name || short(account)}
            {data.me.role ? ` (${ROLE[data.me.role]})` : ""} · free {fmt(data.me.free)} · locked {fmt(data.me.locked)} {SYMBOL}
          </span>
        )}
        {data.me?.claimable > 0n && (
          <button
            className="small"
            onClick={() => tx(() => contract("LiabilityBond", deployments.LiabilityBond, signer).withdrawClaimable(), "Withdraw credited payout")}
          >
            Withdraw {fmt(data.me.claimable)} {SYMBOL} credited
          </button>
        )}
        <button className="small" onClick={connect}>
          {account ? "Reconnect" : "Connect wallet"}
        </button>
      </div>

      {!configured && (
        <div className="banner">
          Contracts not configured. Run <code>npx hardhat node</code>, then <code>npm run deploy:local</code> (it
          writes <code>ui/src/deployments.json</code>) and <code>npm run seed:local</code>, then refresh.
        </div>
      )}
      {configured && oracleOk === false && (
        <div className="banner">
          Oracle service offline at {oracle.url}. Lab results, IPFS uploads and Merkle proofs need it: run{" "}
          <code>npm run oracle</code> in the repo root.
        </div>
      )}

      <div className="main">
        <SetupPanel {...ctx} />

        <div className="center">
          <div className="graph">
            <div className="legend">
              {["Active", "Quarantined", "Recalled"].map((s, i) => (
                <span key={s}>
                  <span className="dot" style={{ background: STATUS_COLOR[i] }} /> {s}
                </span>
              ))}
              <span className="spacer" />
              <button className="small secondary" onClick={refresh}>
                Refresh
              </button>
            </div>
            <div className="graph-canvas">
              {data.lots.length ? (
                <ProvenanceGraph nodes={graph.nodes} edges={graph.edges} />
              ) : (
                <div className="empty">No lots yet. Create a raw lot (no parents) or run the seed script.</div>
              )}
            </div>
          </div>
          <SettlementLedger events={data.events} nameOf={nameOf} />
        </div>

        <div className="panel right">
          <RecallPanel {...ctx} onRecall={setSelected} />
          <DisputePanel {...ctx} selected={selected} setSelected={setSelected} />
          <h2>Activity</h2>
          <div className="log">
            {log.map((l) => (
              <div key={l.t} className={l.kind}>
                {l.kind === "err" ? "✗ " : "· "}
                {l.msg}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
