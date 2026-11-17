/**
 * RecallMesh oracle service — the "accredited lab / regulator" signer.
 *
 * Receives lab results (from a lab UI, the dApp, or the simulated feed), publishes each
 * result as a certificate on IPFS, and — for a failing result — signs an EIP-712 recall
 * that binds the root lot to the certificate CID. In Merkle mode it also computes the
 * affected-set and payout Merkle trees from chain state and serves the proofs.
 *
 *   node offchain/oracle.js            # http://127.0.0.1:8787
 *
 * Endpoints (JSON, CORS-enabled):
 *   GET  /health
 *   POST /lab-results   { lotId, lab?, test?, result: "pass"|"fail", reading?, notes?,
 *                         mode?: "eager"|"merkle", submit?: bool }
 *   GET  /recalls/:id/proofs[?holder=0x…]
 *   POST /recalls/:id/quarantine-all   (relays quarantineWithProof for every affected lot)
 *   POST /recalls/:id/claim-all        (relays claimPayout for every payout entry)
 *   POST /ipfs          { json } | { base64, name?, contentType? }
 *   GET  /ipfs/:cid
 *
 * Env: ORACLE_PRIVATE_KEY (default: Hardhat account #1 locally, PRIVATE_KEY elsewhere),
 * RPC_URL (default: AMOY_RPC_URL on Amoy, else the deployments rpcUrl), DEPLOYMENTS
 * (path to a deployments JSON; default ui/src/deployments.json), ORACLE_PORT, IPFS_CACHE_DIR.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const { ethers } = require("ethers");
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");
const ipfs = require("./ipfs.js");
const { signRecall, signRecallMerkle } = require("../scripts/lib/eip712.js");
const { buildRecallFromChain } = require("../scripts/merkle.js");

const ROOT = path.join(__dirname, "..");
// Well-known Hardhat dev key for account #1. Only used on the local chain (31337).
const HARDHAT_ACCOUNT_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const MAX_NODES = 4096;

function artifactAbi(name) {
  const file = path.join(ROOT, "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Missing ${file} — run \`npx hardhat compile\` first`);
  return JSON.parse(fs.readFileSync(file, "utf8")).abi;
}

/** JSON-safe copy (BigInt -> string). */
const plain = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

/**
 * Build the oracle around an ethers signer + deployed addresses. Exposed separately
 * from the HTTP layer so tests can drive it directly.
 */
async function createOracle({ wallet, deployments, recallsDir }) {
  const provider = wallet.provider;
  const chainId = (await provider.getNetwork()).chainId;
  const lots = new ethers.Contract(deployments.LotRegistry, artifactAbi("LotRegistry"), wallet);
  const engine = new ethers.Contract(deployments.RecallEngine, artifactAbi("RecallEngine"), wallet);
  const engineAddr = await engine.getAddress();
  const dir = recallsDir || path.join(__dirname, ".recalls", `${chainId}-${engineAddr.toLowerCase()}`);

  const onChainOracle = await engine.oracle();
  if (onChainOracle.toLowerCase() !== wallet.address.toLowerCase()) {
    console.warn(`[oracle] WARNING: signer ${wallet.address} is not RecallEngine.oracle (${onChainOracle}); signatures will be rejected`);
  }

  function savePlan(plan) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${plan.qTree.root}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ affected: plan.affected, quarantineTree: plan.qTree.dump(), payoutTree: plan.pTree.dump() })
    );
  }

  function loadPlan(quarantineRoot) {
    const file = path.join(dir, `${quarantineRoot}.json`);
    if (!fs.existsSync(file)) return null;
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      affected: saved.affected,
      qTree: StandardMerkleTree.load(saved.quarantineTree),
      pTree: StandardMerkleTree.load(saved.payoutTree),
    };
  }

  async function labResult(body = {}) {
    const lotId = Number(body.lotId);
    if (!Number.isInteger(lotId) || lotId < 1) throw httpError(400, "lotId must be a positive integer");
    if ((await lots.producerOf(lotId)) === ethers.ZeroAddress) throw httpError(404, `lot ${lotId} does not exist`);
    const result = body.result === "pass" ? "pass" : "fail";

    const certificate = {
      type: "RecallMesh/LabCertificate",
      version: 1,
      lotId,
      lab: String(body.lab || "Accredited Food Safety Lab"),
      test: String(body.test || "Pathogen screen"),
      result,
      reading: body.reading ?? null,
      notes: body.notes ?? null,
      issuedAt: new Date().toISOString(),
      oracle: wallet.address,
      chainId: chainId.toString(),
    };
    const cert = await ipfs.putJSON(certificate, `lab-certificate-lot-${lotId}.json`);
    if (result === "pass") return { recall: false, certificate: cert };

    let mode = body.mode === "merkle" ? "merkle" : "eager";
    let note;
    let plan;
    if (mode === "merkle") {
      plan = await buildRecallFromChain(lots, lotId, MAX_NODES);
      if (!plan.qTree || !plan.pTree) {
        mode = "eager";
        note = "no downstream holders to commit; fell back to an eager recall";
      }
    }

    let signature;
    let params;
    if (mode === "eager") {
      params = { rootLotId: lotId, maxNodes: MAX_NODES, certificateCID: cert.cid };
      signature = await signRecall(wallet, { engine: engineAddr, chainId, ...params });
    } else {
      params = {
        rootLotId: lotId,
        quarantineRoot: plan.qTree.root,
        payoutRoot: plan.pTree.root,
        totalWeight: plan.totalWeight,
        certificateCID: cert.cid,
      };
      signature = await signRecallMerkle(wallet, { engine: engineAddr, chainId, ...params });
      savePlan(plan);
    }

    const out = { recall: true, mode, note, certificate: cert, signature, params: plain(params) };

    if (body.submit) {
      const tx =
        mode === "eager"
          ? await engine.initiateRecall(params.rootLotId, params.maxNodes, params.certificateCID, signature)
          : await engine.initiateRecallMerkle(
              params.rootLotId, params.quarantineRoot, params.payoutRoot, params.totalWeight, params.certificateCID, signature
            );
      const rc = await tx.wait();
      for (const log of rc.logs) {
        try {
          const parsed = engine.interface.parseLog(log);
          if (parsed?.name === "RecallInitiated") out.recallId = Number(parsed.args.recallId);
        } catch {}
      }
      out.txHash = rc.hash;
    }
    return out;
  }

  async function proofs(recallId, holder) {
    const [quarantineRoot] = await engine.recallRoots(recallId);
    if (quarantineRoot === ethers.ZeroHash) throw httpError(404, `recall ${recallId} is not a Merkle recall`);
    const plan = loadPlan(quarantineRoot);
    if (!plan) throw httpError(404, `no saved trees for recall ${recallId} (root ${quarantineRoot})`);
    const quarantine = [];
    for (const [i, v] of plan.qTree.entries()) quarantine.push({ lotId: Number(v[0]), proof: plan.qTree.getProof(i) });
    const payouts = [];
    for (const [i, v] of plan.pTree.entries()) {
      if (holder && v[1].toLowerCase() !== holder.toLowerCase()) continue;
      payouts.push({ lotId: Number(v[0]), holder: v[1], weight: String(v[2]), proof: plan.pTree.getProof(i) });
    }
    return { recallId: Number(recallId), quarantineRoot, quarantine, payouts };
  }

  // Relayer helpers. quarantineWithProof and claimPayout are permissionless and the
  // payout always goes to the holder in the leaf, so the oracle can safely submit them on
  // everyone's behalf (saves one wallet prompt per lot in the demo).
  async function quarantineAll(recallId) {
    const { quarantine } = await proofs(recallId);
    const done = [];
    for (const q of quarantine) {
      if ((await lots.statusOf(q.lotId)) !== 0n) continue; // already Quarantined/Recalled
      await (await engine.quarantineWithProof(recallId, q.lotId, q.proof)).wait();
      done.push(q.lotId);
    }
    return { recallId: Number(recallId), quarantined: done };
  }

  async function claimAll(recallId) {
    const { payouts } = await proofs(recallId);
    const paid = [];
    for (const e of payouts) {
      if (await engine.isClaimed(recallId, e.lotId, e.holder, e.weight)) continue;
      const rc = await (await engine.claimPayout(recallId, e.lotId, e.holder, e.weight, e.proof)).wait();
      paid.push({ lotId: e.lotId, holder: e.holder, weight: e.weight, txHash: rc.hash });
    }
    return { recallId: Number(recallId), paid };
  }

  return { wallet, chainId, engine, lots, labResult, proofs, quarantineAll, claimAll };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, "body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(httpError(400, "invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function createServer(oracle, deployments) {
  const send = (res, status, body, type = "application/json") => {
    res.writeHead(status, {
      "Content-Type": type,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    res.end(Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body));
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname;
      if (req.method === "OPTIONS") return send(res, 204, "", "text/plain");

      if (req.method === "GET" && p === "/health") {
        return send(res, 200, {
          ok: true,
          oracle: oracle.wallet.address,
          chainId: oracle.chainId.toString(),
          recallEngine: deployments.RecallEngine,
        });
      }
      if (req.method === "POST" && p === "/lab-results") {
        return send(res, 200, await oracle.labResult(await readBody(req)));
      }
      let m = p.match(/^\/recalls\/(\d+)\/proofs$/);
      if (req.method === "GET" && m) {
        return send(res, 200, await oracle.proofs(Number(m[1]), url.searchParams.get("holder")));
      }
      m = p.match(/^\/recalls\/(\d+)\/(quarantine-all|claim-all)$/);
      if (req.method === "POST" && m) {
        const fn = m[2] === "quarantine-all" ? oracle.quarantineAll : oracle.claimAll;
        return send(res, 200, await fn(Number(m[1])));
      }
      if (req.method === "POST" && p === "/ipfs") {
        const body = await readBody(req);
        if (body.json !== undefined) return send(res, 200, await ipfs.putJSON(body.json, body.name));
        if (typeof body.base64 === "string") {
          return send(
            res,
            200,
            await ipfs.putBytes(Buffer.from(body.base64, "base64"), { name: body.name, contentType: body.contentType })
          );
        }
        throw httpError(400, "expected { json } or { base64 }");
      }
      m = p.match(/^\/ipfs\/([a-zA-Z0-9]+)$/);
      if (req.method === "GET" && m) {
        const hit = await ipfs.getBytes(m[1]);
        if (!hit) throw httpError(404, "not found");
        return send(res, 200, hit.bytes, hit.contentType);
      }
      throw httpError(404, "no such route");
    } catch (e) {
      send(res, e.status || 500, { error: e.shortMessage || e.reason || e.message });
    }
  });
}

async function main() {
  const depFile = process.env.DEPLOYMENTS || path.join(ROOT, "ui", "src", "deployments.json");
  const deployments = JSON.parse(fs.readFileSync(depFile, "utf8"));
  if (!deployments.RecallEngine) throw new Error(`${depFile} has no RecallEngine address — deploy first`);
  // cacheTimeout -1: ethers otherwise caches identical calls for 250 ms, so back-to-back
  // relayed transactions would read a stale nonce.
  const rpcUrl =
    process.env.RPC_URL || (Number(deployments.chainId) === 80002 && process.env.AMOY_RPC_URL) || deployments.rpcUrl;
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  const chainId = (await provider.getNetwork()).chainId;

  // Local: Hardhat account #1 (what deploy.js makes the oracle). Elsewhere: the deployer
  // key, which deploy.js makes the oracle unless ORACLE_PRIVATE_KEY/ORACLE_ADDRESS was set.
  const key =
    process.env.ORACLE_PRIVATE_KEY || (chainId === 31337n ? HARDHAT_ACCOUNT_1 : process.env.PRIVATE_KEY);
  if (!key) throw new Error("Set PRIVATE_KEY (or ORACLE_PRIVATE_KEY) for non-local networks");
  const wallet = new ethers.Wallet(key, provider);
  const oracle = await createOracle({ wallet, deployments });
  const port = Number(process.env.ORACLE_PORT || 8787);
  createServer(oracle, deployments).listen(port, "127.0.0.1", () => {
    console.log(`[oracle] ${wallet.address} on chain ${chainId} — http://127.0.0.1:${port}`);
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { createOracle, createServer, HARDHAT_ACCOUNT_1 };
