/**
 * RecallMesh test suite (eager recall path).
 * Covers wiring, DAG traversal, throughput-sized bond locks, the ERC-1155 freeze,
 * topology-derived fault attribution, EIP-712 oracle verification, on-chain pro-rata
 * settlement, and the dispute/overturn refund path.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  fixture,
  recallEager,
  expectedShares,
  chainId,
  Role,
  Status,
  CHALLENGE_WINDOW,
  LIABILITY_PERIOD,
  CID,
} = require("./helpers.js");
const { signRecall } = require("../scripts/lib/eip712.js");

const eth = (v) => ethers.parseEther(v);

describe("RecallMesh — structural wiring", function () {
  it("deploys and wires all five contracts", async function () {
    const { engine, lots, bond } = await loadFixture(fixture);
    expect(await lots.recallEngine()).to.equal(await engine.getAddress());
    expect(await lots.bond()).to.equal(await bond.getAddress());
    expect(await bond.lotRegistry()).to.equal(await lots.getAddress());
    expect(await bond.recallEngine()).to.equal(await engine.getAddress());
  });

  it("registers actors and builds the DAG", async function () {
    const { actors, lots, producer } = await loadFixture(fixture);
    expect(await actors.isActive(producer.address)).to.equal(true);
    expect((await lots.getLot(4)).parents.map(Number)).to.deep.equal([2, 3]); // diamond parents
    expect(await lots.lotCount()).to.equal(7n);
  });

  it("rejects lot creation by an unregistered actor", async function () {
    const { lots, outsider } = await loadFixture(fixture);
    await expect(lots.connect(outsider).createLot([], 1, "ipfs://x")).to.be.revertedWith("actor not active");
  });
});

describe("RecallMesh — DAG traversal", function () {
  it("computes the exact affected descendant set (dedupes the diamond, excludes unrelated lots)", async function () {
    const { lots } = await loadFixture(fixture);
    const affected = (await lots.affectedDescendants(1, 50)).map(Number).sort((x, y) => x - y);
    expect(affected).to.deep.equal([2, 3, 4, 5]); // not 6/7
  });

  it("honors the maxNodes traversal cap", async function () {
    const { lots } = await loadFixture(fixture);
    const capped = await lots.affectedDescendants(1, 2);
    expect(capped.length).to.equal(2);
  });
});

describe("RecallMesh — throughput-sized bond locks", function () {
  it("locks bondPerUnit x quantity of the producer's bond when a lot is created", async function () {
    const { bond, producer } = await loadFixture(fixture);
    const [owner, size, remaining] = await bond.lotLock(1);
    expect(owner).to.equal(producer.address);
    expect(size).to.equal(eth("1")); // 100 units x 0.01
    expect(remaining).to.equal(eth("1"));
    expect(await bond.lockedOf(producer.address)).to.equal(eth("1.1")); // L1 + L6
    expect(await bond.bondOf(producer.address)).to.equal(eth("0.9"));
  });

  it("rejects a lot the producer's free bond cannot cover", async function () {
    const { lots, producer } = await loadFixture(fixture);
    await expect(lots.connect(producer).createLot([], 1000, "ipfs://big")).to.be.revertedWith("insufficient bond");
  });

  it("does not let an actor withdraw bond that is locked against its lots", async function () {
    const { bond, producer } = await loadFixture(fixture);
    await expect(bond.connect(producer).withdrawBond(eth("1"))).to.be.revertedWith("insufficient bond");
    await bond.connect(producer).withdrawBond(eth("0.9")); // free part is fine
    expect(await bond.bondOf(producer.address)).to.equal(0n);
  });

  it("releases a lot's lock only after the liability period", async function () {
    const { bond, producer } = await loadFixture(fixture);
    await expect(bond.releaseLot(1)).to.be.revertedWith("liability period active");
    await time.increase(LIABILITY_PERIOD + 1);
    await bond.releaseLot(1); // anyone may call
    expect(await bond.bondOf(producer.address)).to.equal(eth("1.9"));
    expect(await bond.lockedOf(producer.address)).to.equal(eth("0.1"));
    await expect(bond.releaseLot(1)).to.be.revertedWith("nothing locked");
  });
});

describe("RecallMesh — quarantine freeze", function () {
  it("blocks transferCustody, safeTransferFrom and safeBatchTransferFrom of a quarantined lot", async function () {
    const { engine, admin, processor, retailer, lots } = await loadFixture(fixture);
    await recallEager(engine, admin, 1);

    await expect(lots.connect(processor).transferCustody(2, retailer.address, 1)).to.be.revertedWith("lot frozen");
    await expect(
      lots.connect(processor).safeTransferFrom(processor.address, retailer.address, 2, 1, "0x")
    ).to.be.revertedWith("lot frozen");
    await expect(
      lots.connect(processor).safeBatchTransferFrom(processor.address, retailer.address, [7, 2], [1, 1], "0x")
    ).to.be.revertedWith("lot frozen");
    // an unrelated lot still moves
    await lots.connect(processor).safeTransferFrom(processor.address, retailer.address, 7, 1, "0x");
    expect(await lots.balanceOf(retailer.address, 7)).to.equal(1n);
  });

  it("blocks transfers to unregistered addresses on every path", async function () {
    const { lots, processor, outsider } = await loadFixture(fixture);
    await expect(
      lots.connect(processor).safeTransferFrom(processor.address, outsider.address, 2, 1, "0x")
    ).to.be.revertedWith("recipient inactive");
  });

  it("rejects building a new lot on quarantined or recalled stock", async function () {
    const { engine, admin, lots, distributor } = await loadFixture(fixture);
    await recallEager(engine, admin, 1);
    await expect(lots.connect(distributor).createLot([4], 1, "ipfs://x")).to.be.revertedWith("parent frozen");
    await expect(lots.connect(distributor).createLot([1], 1, "ipfs://x")).to.be.revertedWith("parent frozen");
  });
});

describe("RecallMesh — recall initiation", function () {
  it("verifies the EIP-712 oracle signature and rejects a forgery", async function () {
    const { engine, outsider } = await loadFixture(fixture);
    const bad = await signRecall(outsider, {
      engine: await engine.getAddress(), chainId: await chainId(), rootLotId: 1, maxNodes: 50, certificateCID: CID,
    });
    await expect(engine.initiateRecall(1, 50, CID, bad)).to.be.revertedWith("bad oracle sig");
  });

  it("binds the lab certificate CID into the signature", async function () {
    const { engine, admin } = await loadFixture(fixture);
    const sig = await signRecall(admin, {
      engine: await engine.getAddress(), chainId: await chainId(), rootLotId: 1, maxNodes: 50, certificateCID: CID,
    });
    await expect(engine.initiateRecall(1, 50, "bafkreitampered", sig)).to.be.revertedWith("bad oracle sig");
    await engine.initiateRecall(1, 50, CID, sig);
    expect((await engine.getRecall(1)).certificateCID).to.equal(CID);
  });

  it("derives the at-fault actor from the graph, quarantines descendants and slashes the root lot's lock", async function () {
    const { engine, admin, producer, bond, lots } = await loadFixture(fixture);
    await expect(recallEager(engine, admin, 1))
      .to.emit(engine, "RecallInitiated")
      .withArgs(1, 1, producer.address, CID);

    expect((await lots.getLot(1)).status).to.equal(Status.Recalled);
    for (const id of [2, 3, 4, 5]) expect((await lots.getLot(id)).status).to.equal(Status.Quarantined);
    for (const id of [6, 7]) expect((await lots.getLot(id)).status).to.equal(Status.Active);

    const r = await engine.getRecall(1);
    expect(r.atFaultActor).to.equal(producer.address);
    expect(r.slashed).to.equal(eth("1")); // the lock posted for L1
    expect(await bond.escrowOf(1)).to.equal(eth("1"));
    expect((await bond.lotLock(1)).remaining).to.equal(0n);
    expect(await bond.bondOf(producer.address)).to.equal(eth("0.9")); // free bond untouched
    expect((await engine.affectedOf(1)).map(Number)).to.have.members([2, 3, 4, 5]);
  });

  it("attributes a mid-tier defect to that tier's producer", async function () {
    const { engine, admin, processor, lots } = await loadFixture(fixture);
    await recallEager(engine, admin, 2); // contamination introduced at the processor (L2)

    const r = await engine.getRecall(1);
    expect(r.atFaultActor).to.equal(processor.address);
    expect(r.slashed).to.equal(eth("0.5")); // 50 units x 0.01
    expect((await lots.getLot(1)).status).to.equal(Status.Active); // upstream untouched
    expect((await lots.getLot(3)).status).to.equal(Status.Active); // sibling untouched
    for (const id of [4, 5]) expect((await lots.getLot(id)).status).to.equal(Status.Quarantined);
  });

  it("rejects recalling the same root twice (and signature replay)", async function () {
    const { engine, admin } = await loadFixture(fixture);
    const sig = await signRecall(admin, {
      engine: await engine.getAddress(), chainId: await chainId(), rootLotId: 1, maxNodes: 50, certificateCID: CID,
    });
    await engine.initiateRecall(1, 50, CID, sig);
    await expect(engine.initiateRecall(1, 50, CID, sig)).to.be.revertedWith("already recalled");
  });

  it("falls back to the producer's free bond if the lot's lock was already released", async function () {
    const { engine, admin, producer, bond } = await loadFixture(fixture);
    await time.increase(LIABILITY_PERIOD + 1);
    await bond.releaseLot(1); // producer free bond: 0.9 + 1 = 1.9
    await recallEager(engine, admin, 1);
    expect((await engine.getRecall(1)).slashed).to.equal(eth("1"));
    expect(await bond.bondOf(producer.address)).to.equal(eth("0.9"));
  });
});

describe("RecallMesh — settlement", function () {
  it("pays on-chain-computed holders pro-rata; the caller cannot choose recipients", async function () {
    const { engine, admin, processor, distributor, retailer, outsider, bond } = await loadFixture(fixture);
    await recallEager(engine, admin, 1);
    await time.increase(CHALLENGE_WINDOW + 1); // no challenge -> auto-upheld

    // entries in BFS order: L2 processor 50, L3 processor 50, L4 distributor 40, L5 retailer 30
    const s = expectedShares(eth("1"), [50n, 50n, 40n, 30n]);
    await expect(engine.connect(outsider).finalizeRecall(1)).to.changeEtherBalances(
      [processor, distributor, retailer],
      [s[0] + s[1], s[2], s[3]]
    );
    expect(await bond.escrowOf(1)).to.equal(0n); // whole pot paid, no dust left
    await expect(engine.finalizeRecall(1)).to.be.revertedWith("bad state");
  });

  it("excludes the at-fault actor from the payout even if it holds affected stock", async function () {
    const { engine, admin, lots, producer, processor, distributor, retailer, outsider } = await loadFixture(fixture);
    await lots.connect(distributor).transferCustody(4, producer.address, 10); // producer now holds 10 units of L4
    await recallEager(engine, admin, 1);
    await time.increase(CHALLENGE_WINDOW + 1);

    const s = expectedShares(eth("1"), [50n, 50n, 30n, 30n]); // L2, L3, L4 (distributor 30), L5
    await expect(engine.connect(outsider).finalizeRecall(1)).to.changeEtherBalances(
      [processor, distributor, retailer, producer],
      [s[0] + s[1], s[2], s[3], 0n]
    );
  });

  it("credits a holder that rejects ETH instead of blocking everyone else", async function () {
    const { engine, admin, actors, lots, bond, retailer, processor } = await loadFixture(fixture);
    const holder = await ethers.deployContract("RejectingHolder");
    const holderAddr = await holder.getAddress();
    await actors.registerActor(holderAddr, Role.Retailer, "Rejecting Store");
    await lots.connect(retailer).transferCustody(5, holderAddr, 10); // retailer 20, holder 10

    await recallEager(engine, admin, 1);
    await time.increase(CHALLENGE_WINDOW + 1);
    // L2 proc 50, L3 proc 50, L4 dist 40, L5 retailer 20, L5 holder 10
    const s = expectedShares(eth("1"), [50n, 50n, 40n, 20n, 10n]);
    await expect(engine.finalizeRecall(1)).to.changeEtherBalance(processor, s[0] + s[1]);
    expect(await bond.claimableOf(holderAddr)).to.equal(s[4]);
    expect(await bond.escrowOf(1)).to.equal(0n);
  });

  it("refunds the slashed bond when a dispute overturns the attribution", async function () {
    const { engine, admin, producer, bond, disputes } = await loadFixture(fixture);
    await recallEager(engine, admin, 1);

    // accused challenges within the window -> cannot finalize yet
    await disputes.connect(producer).submitChallenge(1, "ipfs://evidence");
    await time.increase(CHALLENGE_WINDOW + 1);
    await expect(engine.finalizeRecall(1)).to.be.revertedWith("dispute unresolved");

    // arbiter overturns -> finalize refunds the slashed lock to the accused's free bond
    await disputes.connect(admin).resolveDispute(1, false);
    await engine.finalizeRecall(1);
    expect(await bond.bondOf(producer.address)).to.equal(eth("1.9"));
    expect(await bond.escrowOf(1)).to.equal(0n);
  });

  it("returns the collateral when no downstream holder was affected", async function () {
    const { engine, admin, retailer, bond } = await loadFixture(fixture);
    await recallEager(engine, admin, 5); // leaf lot: no descendants
    await time.increase(CHALLENGE_WINDOW + 1);
    await engine.finalizeRecall(1);
    expect(await bond.bondOf(retailer.address)).to.equal(eth("1")); // 0.7 free + 0.3 returned
  });
});
