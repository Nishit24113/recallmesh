/**
 * Minimal IPFS content addressing for RecallMesh: lot metadata, lab certificates and
 * dispute evidence live off-chain; only their content IDs (CIDs) go on-chain.
 *
 * CIDs are computed locally as standard CIDv1 (raw codec, sha2-256, base32 — "bafkrei…").
 * For content up to 256 KiB (one IPFS chunk) this is exactly the CID that
 * `ipfs add --cid-version=1 <file>` produces, so anyone can re-derive and check a CID from
 * the bytes, or pin the same file on any IPFS node. Larger inputs are rejected, because IPFS
 * would chunk them into a different (UnixFS) CID.
 *
 * The bytes are kept in a local content-addressed store, served by the oracle service at
 * GET /ipfs/:cid.
 *
 * Env: IPFS_CACHE_DIR (default offchain/.ipfs-cache).
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_BYTES = 256 * 1024; // one IPFS chunk: keeps CIDs identical to `ipfs add --cid-version=1`
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes) {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** CIDv1 (raw codec 0x55, sha2-256 multihash) of `bytes`, multibase base32 ("b…"). */
function rawCid(bytes) {
  const digest = crypto.createHash("sha256").update(bytes).digest();
  const cidBytes = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  return "b" + base32(cidBytes);
}

const storeDir = () => process.env.IPFS_CACHE_DIR || path.join(__dirname, ".ipfs-cache");

/**
 * Store bytes under their CID. Returns { cid, uri: "ipfs://<cid>" }.
 */
async function putBytes(bytes, { name = "file", contentType = "application/octet-stream" } = {}) {
  const buf = Buffer.from(bytes);
  if (buf.length > MAX_BYTES) {
    throw new Error(`content is ${buf.length} bytes; the limit is ${MAX_BYTES} (one IPFS chunk)`);
  }
  const cid = rawCid(buf);
  const dir = storeDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, cid), buf);
  fs.writeFileSync(path.join(dir, cid + ".meta.json"), JSON.stringify({ name, contentType }));
  return { cid, uri: `ipfs://${cid}` };
}

/** Store a JSON document (stable key order as given). */
async function putJSON(obj, name = "document.json") {
  return putBytes(Buffer.from(JSON.stringify(obj)), { name, contentType: "application/json" });
}

/** Read bytes by CID from the local store (null if absent). */
async function getBytes(cid) {
  if (!/^[a-zA-Z0-9]+$/.test(cid)) return null; // CIDs are alphanumeric; blocks path traversal
  const file = path.join(storeDir(), cid);
  if (!fs.existsSync(file)) return null;
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(file + ".meta.json", "utf8"));
  } catch {}
  return { bytes: fs.readFileSync(file), contentType: meta.contentType || "application/octet-stream", name: meta.name };
}

/** "ipfs://<cid>?x" | "<cid>" -> "<cid>" (or null if not an IPFS reference). */
function cidFromUri(uri = "") {
  const m = String(uri).match(/^(?:ipfs:\/\/)?([a-zA-Z0-9]{46,})/);
  return m ? m[1] : null;
}

module.exports = { rawCid, putBytes, putJSON, getBytes, cidFromUri, MAX_BYTES };
