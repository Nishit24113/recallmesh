import { ethers } from "ethers";

export const ROLE = ["None", "Producer", "Supplier", "Processor", "Distributor", "Retailer", "Regulator"];
export const STATUS = ["Active", "Quarantined", "Recalled"];
export const STATUS_COLOR = ["#3a7a4e", "#b5781f", "#c0392b"]; // Active / Quarantined / Recalled
export const MODE = ["Eager", "Merkle"];

// Minimal human-readable ABIs (only what the UI calls or listens to).
export const ABIS = {
  ActorRegistry: [
    "function registerActor(address actor, uint8 role, string name)",
    "function isActive(address) view returns (bool)",
    "function roleOf(address) view returns (uint8)",
    "event ActorRegistered(address indexed actor, uint8 role, string name)",
  ],
  LotRegistry: [
    "function createLot(uint256[] parents, uint256 amount, string metadataURI) returns (uint256)",
    "function transferCustody(uint256 lotId, address to, uint256 amount)",
    "function getLot(uint256) view returns (tuple(uint256 id,address producer,address custodian,uint8 status,uint256[] parents,string metadataURI,uint256 createdAt))",
    "function lotCount() view returns (uint256)",
    "function holdingsOf(uint256 lotId) view returns (address[] holders, uint256[] balances)",
    "function affectedDescendants(uint256,uint256) view returns (uint256[])",
    "function balanceOf(address account, uint256 id) view returns (uint256)",
    "event LotCreated(uint256 indexed lotId, address indexed producer, uint256[] parents)",
    "event LotStatusChanged(uint256 indexed lotId, uint8 status)",
  ],
  LiabilityBond: [
    "function stakeBond() payable",
    "function withdrawBond(uint256 amount)",
    "function bondOf(address) view returns (uint256)",
    "function lockedOf(address) view returns (uint256)",
    "function bondPerUnit() view returns (uint256)",
    "function escrowOf(uint256 recallId) view returns (uint256)",
    "function claimableOf(address) view returns (uint256)",
    "function withdrawClaimable()",
    "event BondStaked(address indexed actor, uint256 amount)",
    "event BondWithdrawn(address indexed actor, uint256 amount)",
    "event BondLocked(address indexed actor, uint256 indexed lotId, uint256 amount, uint256 unlockAt)",
    "event BondReleased(address indexed actor, uint256 indexed lotId, uint256 amount)",
    "event BondSlashed(address indexed actor, uint256 amount, uint256 indexed recallId)",
    "event BondRefunded(address indexed actor, uint256 amount, uint256 indexed recallId)",
    "event PayoutDistributed(uint256 indexed recallId, uint256 totalAmount, uint256 recipients)",
    "event ClaimPaid(uint256 indexed recallId, address indexed to, uint256 amount)",
    "event PayoutCredited(uint256 indexed recallId, address indexed to, uint256 amount)",
  ],
  DisputeModule: [
    "function arbiter() view returns (address)",
    "function submitChallenge(uint256 recallId, string evidenceURI)",
    "function resolveDispute(uint256 recallId, bool upheld)",
    "function isResolved(uint256) view returns (bool)",
    "function isUpheld(uint256) view returns (bool)",
    "function getDispute(uint256) view returns (address accused, uint256 deadline, bool challenged, bool resolved, bool upheld)",
    "event ChallengeSubmitted(uint256 indexed recallId, address indexed accused, string evidenceURI)",
    "event DisputeResolved(uint256 indexed recallId, bool upheld)",
  ],
  RecallEngine: [
    "function initiateRecall(uint256 rootLotId, uint256 maxNodes, string certificateCID, bytes oracleSig) returns (uint256)",
    "function initiateRecallMerkle(uint256 rootLotId, bytes32 quarantineRoot, bytes32 payoutRoot, uint256 totalWeight, string certificateCID, bytes oracleSig) returns (uint256)",
    "function finalizeRecall(uint256 recallId)",
    "function claimPayout(uint256 recallId, uint256 lotId, address holder, uint256 weight, bytes32[] proof)",
    "function isClaimed(uint256 recallId, uint256 lotId, address holder, uint256 weight) view returns (bool)",
    "function recallCount() view returns (uint256)",
    "function getRecall(uint256) view returns (tuple(uint256 id,uint256 rootLotId,address atFaultActor,uint8 state,uint8 mode,uint256 initiatedAt,uint256 slashed,string certificateCID))",
    "function affectedOf(uint256) view returns (uint256[])",
    "function oracle() view returns (address)",
    "event RecallInitiated(uint256 indexed recallId, uint256 indexed rootLotId, address indexed atFaultActor, string certificateCID)",
    "event RecallFinalized(uint256 indexed recallId, uint256 slashedAmount)",
    "event LotQuarantinedMerkle(uint256 indexed recallId, uint256 indexed lotId)",
    "event PayoutClaimed(uint256 indexed recallId, uint256 indexed lotId, address indexed holder, uint256 amount)",
  ],
};

export function contract(name, address, runner) {
  return new ethers.Contract(address, ABIS[name], runner);
}

export const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");

/** Legacy demo URIs carried the product name in the query string. */
export const legacyName = (uri = "") => {
  const m = uri.match(/[?&]name=([^&]*)/);
  return m ? decodeURIComponent(m[1]) : "";
};

/** Children adjacency from lots' parent lists. */
export function childrenMap(lots) {
  const kids = new Map();
  lots.forEach((l) => l.parents.forEach((p) => kids.set(p, [...(kids.get(p) || []), l.id])));
  return kids;
}

/**
 * BFS layers from `root` restricted to `ids`: [[root], [children…], [grandchildren…], …].
 * Used to animate the quarantine wave in DAG order.
 */
export function propagationLayers(lots, root, ids) {
  const allowed = new Set(ids);
  const kids = childrenMap(lots);
  const seen = new Set([root]);
  const layers = [[root]];
  let frontier = [root];
  while (frontier.length) {
    const next = [];
    for (const n of frontier) {
      for (const c of kids.get(n) || []) {
        if (allowed.has(c) && !seen.has(c)) {
          seen.add(c);
          next.push(c);
        }
      }
    }
    if (next.length) layers.push(next);
    frontier = next;
  }
  return layers;
}

// Generate react-flow nodes/edges from on-chain lot data, auto-laid-out by DAG depth.
// `display` optionally overrides a lot's status (used while animating a recall).
export function buildGraph(lots, display = {}, roots = new Set()) {
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
  const statusOf = (l) => (display[l.id] ?? l.status);

  const nodes = [];
  Object.entries(byLevel).forEach(([lvl, arr]) => {
    arr.forEach((l, i) => {
      const st = statusOf(l);
      nodes.push({
        id: String(l.id),
        position: { x: i * 220 + 30, y: Number(lvl) * 140 + 20 },
        data: {
          label: `L${l.id}${l.name ? " · " + l.name : ""}\n${l.producerName || ROLE[l.role] || "?"}\n${STATUS[st]}${roots.has(l.id) ? " · root" : ""}`,
        },
        style: {
          background: STATUS_COLOR[st],
          color: "white",
          border: roots.has(l.id) ? "2px solid #fff" : "1px solid rgba(255,255,255,.25)",
          borderRadius: 10,
          fontSize: 13,
          fontWeight: 600,
          padding: 10,
          width: 190,
          whiteSpace: "pre-line",
          textAlign: "center",
          transition: "background-color .45s ease, box-shadow .45s ease",
          boxShadow: st !== 0 ? `0 0 0 4px ${STATUS_COLOR[st]}55` : "none",
        },
      });
    });
  });

  const edges = [];
  lots.forEach((l) =>
    l.parents.forEach((p) => {
      const hot = statusOf(l) !== 0;
      edges.push({
        id: `${p}-${l.id}`,
        source: String(p),
        target: String(l.id),
        animated: hot,
        style: { stroke: hot ? "#c0392b" : "#5b6b86", strokeWidth: hot ? 2 : 1 },
      });
    })
  );
  return { nodes, edges };
}
