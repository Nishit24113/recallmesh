/**
 * Client for the RecallMesh oracle service (offchain/oracle.js): lab results, Merkle
 * proofs and relaying, and IPFS uploads/reads.
 */
export function oracleClient(baseUrl) {
  const base = baseUrl.replace(/\/$/, "");
  const call = async (path, opts) => {
    let res;
    try {
      res = await fetch(base + path, opts);
    } catch {
      throw new Error(`Oracle service unreachable at ${base} — start it with \`npm run oracle\``);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  };
  const post = (path, body) =>
    call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  return {
    url: base,
    health: () => call("/health"),
    labResult: (body) => post("/lab-results", body),
    proofs: (recallId, holder) => call(`/recalls/${recallId}/proofs${holder ? `?holder=${holder}` : ""}`),
    quarantineAll: (recallId) => post(`/recalls/${recallId}/quarantine-all`, {}),
    claimAll: (recallId) => post(`/recalls/${recallId}/claim-all`, {}),
    putJSON: (json, name) => post("/ipfs", { json, name }),
    ipfsUrl: (cid) => `${base}/ipfs/${cid}`,
  };
}

export const cidOf = (uri = "") => {
  const m = String(uri).match(/^(?:ipfs:\/\/)?([a-zA-Z0-9]{46,})/);
  return m ? m[1] : null;
};

const metaCache = new Map();

/** Resolve a lot's metadata JSON (name, quantity, unit…) from its ipfs:// URI. */
export async function lotMetadata(oracle, uri) {
  const cid = cidOf(uri);
  if (!cid) return null;
  if (metaCache.has(cid)) return metaCache.get(cid);
  const p = fetch(oracle.ipfsUrl(cid))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  metaCache.set(cid, p);
  const v = await p;
  if (!v) metaCache.delete(cid); // retry later (e.g. oracle was down)
  return v;
}
