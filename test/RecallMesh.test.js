/**
 * RecallMesh test suite.
 * Covers the structural wiring plus the full recall flow: DAG traversal correctness,
 * EIP-712 oracle verification (and forgery rejection), quarantine, slashing + pro-rata
 * payout, and the dispute/overturn refund path.
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const Role = { None: 0, Producer: 1, Supplier: 2, Processor: 3, Distributor: 4, Retailer: 5, Regulator: 6 };
const Status = { Active: 0, Quarantined: 1, Recalled: 2 };
const CHALLENGE_WINDOW = 3 * 24 * 60 * 60; // matches RecallEngine default (3 days)

// Deploy everything, register actors, and build a multi-tier provenance DAG:
//
//        L1 (producer, raw)
//        /        \
//      L2         L3        (processor)
//        \        /
//          L4              (distributor; diamond: reachable via L2 and L3)
//          |
//          L5              (retailer)
//
//   L6 (producer, raw) -> L7 (processor)   <-- unrelated branch, must stay unaffected
async function fixture() {
  const [admin, producer, processor, distributor, retailer, outsider] = await ethers.getSigners();
  const a = admin.address;

  const actors = await ethers.deployContract("ActorRegistry", [a]);
  const bond = await ethers.deployContract("LiabilityBond", [a]);
  const disputes = await ethers.deployContract("DisputeModule", [a, a]); // arbiter=admin, owner=admin
  const lots = await ethers.deployContract("LotRegistry", [await actors.getAddress(), a]);
  const engine = await ethers.deployContract("RecallEngine", [
    await lots.getAddress(),
    await bond.getAddress(),
    await disputes.getAddress(),
    await actors.getAddress(),
    a, // oracle
    a, // owner
  ]);
  await lots.setRecallEngine(await engine.getAddress());
  await bond.setRecallEngine(await engine.getAddress());
  await disputes.setRecallEngine(await engine.getAddress());

  await actors.registerActor(producer.address, Role.Producer, "Farm");
  await actors.registerActor(processor.address, Role.Processor, "Mill");
  await actors.registerActor(distributor.address, Role.Distributor, "Dist");
  await actors.registerActor(retailer.address, Role.Retailer, "Store");

  // Build the DAG (lot ids auto-increment from 1).
  await lots.connect(producer).createLot([], 100, "ipfs://L1"); // 1
  await lots.connect(processor).createLot([1], 50, "ipfs://L2"); // 2
  await lots.connect(processor).createLot([1], 50, "ipfs://L3"); // 3
  await lots.connect(distributor).createLot([2, 3], 40, "ipfs://L4"); // 4 (diamond)
  await lots.connect(retailer).createLot([4], 30, "ipfs://L5"); // 5
  await lots.connect(producer).createLot([], 10, "ipfs://L6"); // 6 (unrelated)
  await lots.connect(processor).createLot([6], 5, "ipfs://L7"); // 7 (unrelated)

  return { admin, producer, processor, distributor, retailer, outsider, actors, bond, disputes, lots, engine };
}

// Build an EIP-712 signature for a recall from `signer`.
async function signRecall(signer, engine, rootLotId, atFaultActor, maxNodes) {
  const domain = {
    name: "RecallMesh",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await engine.getAddress(),
  };
  const types = {
    Recall: [
      { name: "rootLotId", type: "uint256" },
      { name: "atFaultActor", type: "address" },
      { name: "maxNodes", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, { rootLotId, atFaultActor, maxNodes });
}

describe("RecallMesh — structural wiring", function () {
  it("deploys and wires all five contracts", async function () {
    const { engine, lots } = await loadFixture(fixture);
    expect(await lots.recallEngine()).to.equal(await engine.getAddress());
  });

  it("registers actors and builds the DAG", async function () {
    const { actors, lots, producer } = await loadFixture(fixture);
    expect(await actors.isActive(producer.address)).to.equal(true);
    expect((await lots.getLot(4)).parents.map(Number)).to.deep.equal([2, 3]); // diamond parents
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

describe("RecallMesh — recall flow", function () {
  it("verifies the EIP-712 oracle signature and rejects a forgery", async function () {
    const { engine, producer, outsider } = await loadFixture(fixture);
    const bad = await signRecall(outsider, engine, 1, producer.address, 50); // not the oracle
    await expect(engine.initiateRecall(1, producer.address, 50, bad)).to.be.revertedWith("bad oracle sig");
  });

  it("quarantines the affected set, freezes transfers, and slashes the at-fault bond", async function () {
    const { engine, admin, producer, processor, retailer, bond, lots } = await loadFixture(fixture);
    await bond.connect(producer).stakeBond({ value: ethers.parseEther("1") });

    const sig = await signRecall(admin, engine, 1, producer.address, 50);
    await engine.initiateRecall(1, producer.address, 50, sig);

    expect((await lots.getLot(1)).status).to.equal(Status.Recalled);
    for (const id of [2, 3, 4, 5]) expect((await lots.getLot(id)).status).to.equal(Status.Quarantined);
    expect((await lots.getLot(6)).status).to.equal(Status.Active); // unrelated untouched

    // quarantined lot cannot be transferred
    await expect(lots.connect(processor).transferCustody(2, retailer.address, 1)).to.be.revertedWith("lot frozen");

    // bond slashed into escrow
    expect(await bond.bondOf(producer.address)).to.equal(0);
  });

  it("pays the slashed collateral pro-rata to downstream holders on finalize", async function () {
    const { engine, admin, producer, processor, distributor, retailer, bond } = await loadFixture(fixture);
    await bond.connect(producer).stakeBond({ value: ethers.parseEther("1") });
    const sig = await signRecall(admin, engine, 1, producer.address, 50);
    await engine.initiateRecall(1, producer.address, 50, sig);

    // no challenge -> auto-upheld after the window
    await time.increase(CHALLENGE_WINDOW + 1);

    // downstream holders of quarantined lots and their weights (quarantined quantity held):
    // processor holds L2(50)+L3(50)=100, distributor L4(40), retailer L5(30); total 170
    const holders = [processor.address, distributor.address, retailer.address];
    const weights = [100n, 40n, 30n];
    const pot = ethers.parseEther("1");
    const total = 170n;
    const expected = weights.map((w) => (pot * w) / total);

    await expect(engine.finalizeRecall(1, holders, weights)).to.changeEtherBalances(
      [processor, distributor, retailer],
      expected
    );
  });

  it("refunds the slashed bond when a dispute overturns the attribution", async function () {
    const { engine, admin, producer, bond, disputes } = await loadFixture(fixture);
    await bond.connect(producer).stakeBond({ value: ethers.parseEther("1") });
    const sig = await signRecall(admin, engine, 1, producer.address, 50);
    await engine.initiateRecall(1, producer.address, 50, sig);

    // accused challenges within the window -> cannot finalize yet
    await disputes.connect(producer).submitChallenge(1, "ipfs://evidence");
    await expect(engine.finalizeRecall(1, [producer.address], [1])).to.be.revertedWith("dispute unresolved");

    // arbiter overturns -> finalize refunds the bond to the accused
    await disputes.connect(admin).resolveDispute(1, false);
    await engine.finalizeRecall(1, [], []);
    expect(await bond.bondOf(producer.address)).to.equal(ethers.parseEther("1"));
  });
});
