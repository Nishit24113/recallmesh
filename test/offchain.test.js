/**
 * Off-chain components: the local IPFS CID fallback and the oracle service, driven
 * directly (no HTTP) against the in-process Hardhat chain.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { fixture, Status, CHALLENGE_WINDOW } = require("./helpers.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recallmesh-test-"));
process.env.IPFS_CACHE_DIR = path.join(tmp, "ipfs");

const ipfs = require("../offchain/ipfs.js");
const { createOracle } = require("../offchain/oracle.js");

async function oracleFor(ctx, name) {
  return createOracle({
    wallet: ctx.admin, // the fixture's RecallEngine.oracle
    deployments: { LotRegistry: await ctx.lots.getAddress(), RecallEngine: await ctx.engine.getAddress() },
    recallsDir: path.join(tmp, "recalls", name),
  });
}

describe("RecallMesh — off-chain IPFS", function () {
  it("computes standard CIDv1 raw/sha2-256 identifiers", function () {
    // well-known CID of the empty byte string
    expect(ipfs.rawCid(Buffer.alloc(0))).to.equal("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
  });

  it("rejects content larger than one IPFS chunk (CID would no longer match `ipfs add`)", async function () {
    await ipfs.putBytes(Buffer.alloc(ipfs.MAX_BYTES)); // exactly one chunk is fine
    try {
      await ipfs.putBytes(Buffer.alloc(ipfs.MAX_BYTES + 1));
      expect.fail("should have thrown");
    } catch (e) {
      expect(e.message).to.match(/limit/);
    }
  });

  it("stores and retrieves content by CID", async function () {
    const doc = { lotId: 1, result: "fail" };
    const a = await ipfs.putJSON(doc);
    const b = await ipfs.putJSON(doc);
    expect(a.cid).to.equal(b.cid).and.match(/^bafkrei/);
    const hit = await ipfs.getBytes(a.cid);
    expect(JSON.parse(hit.bytes.toString())).to.deep.equal(doc);
    expect(ipfs.cidFromUri(a.uri)).to.equal(a.cid);
  });
});

describe("RecallMesh — oracle service", function () {
  it("publishes a passing result as a certificate without signing a recall", async function () {
    const ctx = await loadFixture(fixture);
    const oracle = await oracleFor(ctx, "pass");
    const r = await oracle.labResult({ lotId: 2, result: "pass" });
    expect(r.recall).to.equal(false);
    const cert = JSON.parse((await ipfs.getBytes(r.certificate.cid)).bytes.toString());
    expect(cert).to.include({ lotId: 2, result: "pass" });
  });

  it("signs an eager recall the contract accepts, bound to the certificate CID", async function () {
    const ctx = await loadFixture(fixture);
    const oracle = await oracleFor(ctx, "eager");
    const r = await oracle.labResult({ lotId: 1, result: "fail", submit: true });
    expect(r.recallId).to.equal(1);
    expect((await ctx.engine.getRecall(1)).certificateCID).to.equal(r.certificate.cid);
    expect((await ctx.lots.getLot(4)).status).to.equal(Status.Quarantined);
  });

  it("signs a Merkle recall and serves proofs that quarantine and pay out on-chain", async function () {
    const ctx = await loadFixture(fixture);
    const oracle = await oracleFor(ctx, "merkle");
    const r = await oracle.labResult({ lotId: 1, result: "fail", mode: "merkle", submit: true });
    expect(r.mode).to.equal("merkle");

    const p = await oracle.proofs(r.recallId);
    expect(p.quarantine.map((q) => q.lotId).sort()).to.deep.equal([2, 3, 4, 5]);
    for (const q of p.quarantine) await ctx.engine.quarantineWithProof(r.recallId, q.lotId, q.proof);
    expect((await ctx.lots.getLot(5)).status).to.equal(Status.Quarantined);

    await time.increase(CHALLENGE_WINDOW + 1);
    const mine = await oracle.proofs(r.recallId, ctx.retailer.address);
    expect(mine.payouts).to.have.length(1);
    const e = mine.payouts[0];
    await expect(ctx.engine.claimPayout(r.recallId, e.lotId, e.holder, e.weight, e.proof)).to.changeEtherBalance(
      ctx.retailer,
      (ethers.parseEther("1") * 30n) / 170n
    );
  });

  it("rejects a lab result for a lot that does not exist", async function () {
    const ctx = await loadFixture(fixture);
    const oracle = await oracleFor(ctx, "missing");
    try {
      await oracle.labResult({ lotId: 99, result: "fail" });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e.status).to.equal(404);
    }
  });
});
