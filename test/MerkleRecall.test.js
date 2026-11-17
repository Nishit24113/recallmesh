/**
 * Tests for the scalable Merkle-anchored recall path:
 *  - initiation commits off-chain roots and is O(1) (no on-chain traversal/loop)
 *  - lots are quarantined lazily via membership proofs (and bad proofs are rejected)
 *  - downstream holders pull their pro-rata share with a proof (double-claim rejected)
 *  - settlement rules: upheld -> claims only; overturned -> refund, claims blocked
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { fixture, recallEager, signMerkle, Status, CHALLENGE_WINDOW, CID } = require("./helpers.js");
const { quarantineProof, payoutProof, buildRecallFromChain } = require("../scripts/merkle.js");

const eth = (v) => ethers.parseEther(v);

// Initiate a Merkle recall of root lot 1 with trees computed from chain state.
async function initiate(ctx) {
  const { engine, admin, lots } = ctx;
  const plan = await buildRecallFromChain(lots, 1);
  const sig = await signMerkle(admin, engine, 1, plan.qTree.root, plan.pTree.root, plan.totalWeight);
  await engine.initiateRecallMerkle(1, plan.qTree.root, plan.pTree.root, plan.totalWeight, CID, sig);
  return plan;
}

describe("RecallMesh — Merkle-anchored scalable recall", function () {
  it("builds the payout table from on-chain balances, excluding the at-fault producer", async function () {
    const ctx = await loadFixture(fixture);
    const plan = await buildRecallFromChain(ctx.lots, 1);
    expect(plan.affected.sort((a, b) => a - b)).to.deep.equal([2, 3, 4, 5]);
    expect(plan.totalWeight).to.equal(170n); // 50 + 50 + 40 + 30
    expect(plan.entries.some((e) => e.holder === ctx.producer.address)).to.equal(false);
  });

  it("initiates with committed roots (no on-chain traversal) and quarantines the root only", async function () {
    const ctx = await loadFixture(fixture);
    const { engine, lots, bond, producer } = ctx;
    const plan = await initiate(ctx);

    expect((await lots.getLot(1)).status).to.equal(Status.Recalled);
    // descendants are NOT yet quarantined (lazy) — proves initiation did no per-lot loop
    for (const id of [2, 3, 4, 5]) expect((await lots.getLot(id)).status).to.equal(Status.Active);
    expect(await bond.escrowOf(1)).to.equal(eth("1")); // L1's lock slashed into escrow
    const r = await engine.getRecall(1);
    expect(r.atFaultActor).to.equal(producer.address);
    expect(r.mode).to.equal(1n); // Merkle
    expect(r.certificateCID).to.equal(CID);
    const [qr, , tw] = await engine.recallRoots(1);
    expect(qr).to.equal(plan.qTree.root);
    expect(tw).to.equal(170n);
  });

  it("quarantines affected lots by Merkle proof and rejects a bad proof / an unrelated lot", async function () {
    const ctx = await loadFixture(fixture);
    const { engine, lots } = ctx;
    const { qTree } = await initiate(ctx);

    await engine.quarantineWithProof(1, 2, quarantineProof(qTree, 2));
    expect((await lots.getLot(2)).status).to.equal(Status.Quarantined);

    await expect(engine.quarantineWithProof(1, 2, quarantineProof(qTree, 2))).to.be.revertedWith("already quarantined");
    // lot 6 is unrelated and not in the tree -> any proof fails
    await expect(engine.quarantineWithProof(1, 6, quarantineProof(qTree, 3))).to.be.revertedWith("bad proof");
  });

  it("lets anyone submit a holder's claim; the share goes to the holder; double-claims blocked", async function () {
    const ctx = await loadFixture(fixture);
    const { engine, processor, distributor, outsider } = ctx;
    const { pTree } = await initiate(ctx);
    await time.increase(CHALLENGE_WINDOW + 1); // no challenge -> auto-upheld

    const share = (w) => (eth("1") * w) / 170n;
    await expect(
      engine.connect(outsider).claimPayout(1, 2, processor.address, 50, payoutProof(pTree, 2, processor.address, 50))
    ).to.changeEtherBalance(processor, share(50n));
    await expect(
      engine.claimPayout(1, 4, distributor.address, 40, payoutProof(pTree, 4, distributor.address, 40))
    ).to.changeEtherBalance(distributor, share(40n));
    expect(await engine.isClaimed(1, 2, processor.address, 50)).to.equal(true);

    await expect(
      engine.claimPayout(1, 2, processor.address, 50, payoutProof(pTree, 2, processor.address, 50))
    ).to.be.revertedWith("already claimed");
    // inflating the weight breaks the proof
    await expect(
      engine.claimPayout(1, 3, processor.address, 500, payoutProof(pTree, 3, processor.address, 50))
    ).to.be.revertedWith("bad proof");
  });

  it("does not let finalizeRecall bypass the proofs when the attribution stands", async function () {
    const ctx = await loadFixture(fixture);
    await initiate(ctx);
    await time.increase(CHALLENGE_WINDOW + 1);
    await expect(ctx.engine.finalizeRecall(1)).to.be.revertedWith("use claimPayout");
  });

  it("refunds on an overturned dispute and then blocks claims", async function () {
    const ctx = await loadFixture(fixture);
    const { engine, admin, producer, processor, disputes, bond } = ctx;
    const { pTree } = await initiate(ctx);

    await disputes.connect(producer).submitChallenge(1, "ipfs://evidence");
    await disputes.connect(admin).resolveDispute(1, false);
    await engine.finalizeRecall(1);
    expect(await bond.bondOf(producer.address)).to.equal(eth("1.9"));

    await expect(
      engine.claimPayout(1, 2, processor.address, 50, payoutProof(pTree, 2, processor.address, 50))
    ).to.be.revertedWith("attribution overturned");
  });

  it("rejects proof operations on an eager recall", async function () {
    const ctx = await loadFixture(fixture);
    await recallEager(ctx.engine, ctx.admin, 1);
    await expect(ctx.engine.quarantineWithProof(1, 2, [])).to.be.revertedWith("not a merkle recall");
    await expect(ctx.engine.claimPayout(1, 2, ctx.processor.address, 50, [])).to.be.revertedWith("not a merkle recall");
  });
});
