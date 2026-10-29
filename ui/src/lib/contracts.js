import { ethers } from "ethers";

export const ROLE = ["None", "Producer", "Supplier", "Processor", "Distributor", "Retailer", "Regulator"];
export const STATUS = ["Active", "Quarantined", "Recalled"];
export const STATUS_COLOR = ["#3a7a4e", "#b5781f", "#c0392b"]; // Active / Quarantined / Recalled

// Minimal human-readable ABIs (only what the UI calls).
export const ABIS = {
  ActorRegistry: [
    "function registerActor(address actor, uint8 role, string name)",
    "function isActive(address) view returns (bool)",
    "function roleOf(address) view returns (uint8)",
  ],
  LotRegistry: [
    "function createLot(uint256[] parents, uint256 amount, string metadataURI) returns (uint256)",
    "function getLot(uint256) view returns (tuple(uint256 id,address producer,address custodian,uint8 status,uint256[] parents,string metadataURI,uint256 createdAt))",
    "function affectedDescendants(uint256,uint256) view returns (uint256[])",
    "event LotCreated(uint256 indexed lotId, address indexed producer, uint256[] parents)",
    "event LotStatusChanged(uint256 indexed lotId, uint8 status)",
  ],
  LiabilityBond: [
    "function stakeBond() payable",
    "function bondOf(address) view returns (uint256)",
  ],
  DisputeModule: ["function resolveDispute(uint256 recallId, bool upheld)"],
  RecallEngine: [
    "function initiateRecall(uint256 rootLotId, address atFaultActor, uint256 maxNodes, bytes oracleSig) returns (uint256)",
    "function finalizeRecall(uint256 recallId, address[] holders, uint256[] weights)",
    "event RecallInitiated(uint256 indexed recallId, uint256 indexed rootLotId, address indexed atFaultActor)",
  ],
};

export function contract(name, address, runner) {
  return new ethers.Contract(address, ABIS[name], runner);
}

// EIP-712 recall signature (matches RecallEngine's domain + typehash).
export async function signRecall(signer, engineAddress, chainId, rootLotId, atFaultActor, maxNodes) {
  const domain = { name: "RecallMesh", version: "1", chainId, verifyingContract: engineAddress };
  const types = {
    Recall: [
      { name: "rootLotId", type: "uint256" },
      { name: "atFaultActor", type: "address" },
      { name: "maxNodes", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, { rootLotId, atFaultActor, maxNodes });
}

// Generate react-flow nodes/edges from on-chain lot data, auto-laid-out by DAG depth.
export function buildGraph(lots) {
  const map = new Map(lots.map((l) => [l.id, l]));
  const depthCache = {};
  const depth = (id) => {
    if (depthCache[id] != null) return depthCache[id];
    const l = map.get(id);
    const d = !l || l.parents.length === 0 ? 0 : 1 + Math.max(...l.parents.map(depth));
    depthCache[id] = d;
    return d;
  };
  const byLevel = {};
  lots.forEach((l) => {
    const d = depth(l.id);
    (byLevel[d] = byLevel[d] || []).push(l);
  });

  const nodes = [];
  Object.entries(byLevel).forEach(([lvl, arr]) => {
    arr.forEach((l, i) => {
      nodes.push({
        id: String(l.id),
        position: { x: i * 190 + 30, y: Number(lvl) * 130 + 20 },
        data: { label: `L${l.id} · ${ROLE[l.role] || "?"}\n${STATUS[l.status]}` },
        style: {
          background: STATUS_COLOR[l.status],
          color: "white",
          border: "1px solid rgba(255,255,255,.25)",
          borderRadius: 8,
          fontSize: 12,
          width: 150,
          whiteSpace: "pre-line",
          textAlign: "center",
        },
      });
    });
  });

  const edges = [];
  lots.forEach((l) =>
    l.parents.forEach((p) =>
      edges.push({
        id: `${p}-${l.id}`,
        source: String(p),
        target: String(l.id),
        animated: l.status !== 0,
        style: { stroke: l.status !== 0 ? "#c0392b" : "#5b6b86" },
      })
    )
  );
  return { nodes, edges };
}
