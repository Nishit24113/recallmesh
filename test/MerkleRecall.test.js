/**
 * Tests for the scalable Merkle-anchored recall path:
 *  - initiation commits off-chain roots and is O(1) (no on-chain traversal/loop)
 *  - lots are quarantined lazily via membership proofs (and bad proofs are rejected)
 *  - downstream holders pull their pro-rata share with a proof (double-claim rejected)
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { buildQuarantineTree, quarantineProof, buildPayoutTree, payoutProof } = require("../scripts/merkle.js");

const Role = { Producer: 1, Processor: 3, Distributor: 4, Retailer: 5 };
const Status = { Active: 0, Quarantined: 1, Recalled: 2 };
const WINDOW = 3 * 24 * 60 * 60;

async function fixture() {
  const [admin, producer, processor, distributor, retailer, outsider] = await ethers.getSigners();
  const a = admin.address;
  const actors = await ethers.deployContract("ActorRegistry", [a]);
  const bond = await ethers.deployContract("LiabilityBond", [a]);
  const disputes = await ethers.deployContract("DisputeModule", [a, a]);
  const lots = await ethers.deployContract("LotRegistry", [await actors.getAddress(), a]);
  const engine = await ethers.deployContract("RecallEngine", [
    await lots.getAddress(), await bond.getAddress(), await disputes.getAddress(),
    await actors.getAddress(), a, a,
  ]);
  await lots.setRecallEngine(await engine.getAddress());
  await bond.setRecallEngine(await engine.getAddress());
  await disputes.setRecallEngine(await engine.getAddress());
  await actors.registerActor(producer.address, Role.Producer, "Farm");
  await actors.registerActor(processor.address, Role.Processor, "Mill");
  await actors.registerActor(distributor.address, Role.Distributor, "Dist");
  await actors.registerActor(retailer.address, Role.Retailer, "Store");
  // DAG: L1 -> {L2,L3} -> L4 -> L5 ; L6 -> L7 unrelated
  await lots.connect(producer).createLot([], 100, "ipfs://L1");
  await lots.connect(processor).createLot([1], 50, "ipfs://L2");
  await lots.connect(processor).createLot([1], 50, "ipfs://L3");
  await lots.connect(distributor).createLot([2, 3], 40, "ipfs://L4");
  await lots.connect(retailer).createLot([4], 30, "ipfs://L5");
  await lots.connect(producer).createLot([], 10, "ipfs://L6");
  await lots.connect(processor).createLot([6], 5, "ipfs://L7");
  return { admin, producer, processor, distributor, retailer, outsider, actors, bond, disputes, lots, engine };
}

async function signMerkle(signer, engine, rootLotId, atFault, qRoot, pRoot, totalWeight) {
  const domain = {
    name: "RecallMesh", version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await engine.getAddress(),
  };
  const types = {
    RecallMerkle: [
      { name: "rootLotId", type: "uint256" },
      { name: "atFaultActor", type: "address" },
      { name: "quarantineRoot", type: "bytes32" },
      { name: "payoutRoot", type: "bytes32" },
      { name: "totalWeight", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, { rootLotId, atFaultActor: atFault, quarantineRoot: qRoot, payoutRoot: pRoot, totalWeight });
}

// Build the off-chain trees for a recall of root lot 1.
async function buildTrees(lots) {
  const affected = (await lots.affectedDescendants(1, 4096)).map(Number); // [2,3,4,5]
  const qTree = buildQuarantineTree(affected);
  const entries = [];
  for (const id of affected) {
    const lot = await lots.getLot(id);
    entries.push({ lotId: id, holder: lot.custodian, weight: 1 }); // weight 1 per affected lot
  }
  const pTree = buildPayoutTree(entries);
  return { affected, qTree, pTree, totalWeight: entries.length, entries };
}

describe("RecallMesh — Merkle-anchored scalable recall", function () {
  it("initiates with committed roots (no on-chain traversal) and quarantines the root only", async function () {
    const { engine, admin, producer, bond, lots } = await loadFixture(fixture);
    await bond.connect(producer).stakeBond({ value: ethers.parseEther("1") });
    const { qTree, pTree, totalWeight } = await buildTrees(lots);
    const sig = await signMerkle(admin, engine, 1, producer.address, qTree.root, pTree.root, totalWeight);

    await engine.initiateRecallMerkle(1, producer.address, qTree.root, pTree.root, totalWeight, sig);

    expect((await lots.getLot(1)).status).to.equal(Status.Recalled);
    // descendants are NOT yet quarantined (lazy) — proves initiation did no per-lot loop
    for (const id of [2, 3, 4, 5]) expect((await lots.getLot(id)).status).to.equal(Status.Active);
    expect(await bond.bondOf(producer.address)).to.equal(0); // slashed into escrow
    const [qr, pr, tw] = await engine.recallRoots(1);
    expect(qr).to.equal(qTree.root);
    expect(tw).to.equal(4n);
  });

  it("quarantines affected lots by Merkle proof and rejects a bad proof / an unrelated lot", async function () {
    const { engine, admin, producer, bond, lots } = await loadFixture(fixture);
    await bond.connect(producer).stakeBond({ value: ethers.parseEther("1") });
    const { qTree, pTree, totalWeight } = await buildTrees(lots);
    const sig = await signMerkle(admin, engine, 1, producer.address, qTree.root, pTree.root, totalWeight);
    await engine.initiateRecallMerkle(1, producer.address, qTree.root, pTree.root, totalWeight, sig);

    await engine.quarantineWithProof(1, 2, quarantineProof(qTree, 2));
    expect((await lots.getLot(2)).status).to.equal(Status.Quarantined);

    // re-quarantine rejected
    await expect(engine.quarantineWithProof(1, 2, quarantineProof(qTree, 2))).to.be.revertedWith("already quarantined");
    // lot 6 is unrelated and not in the tree -> any proof fails
    await expect(engine.quarantineWithProof(1, 6, quarantineProof(qTree, 3))).to.be.revertedWith("bad proof");
  });

  it("lets downstream holders pull their pro-rata share by proof, and blocks double-claims", async function () {
    const { engine, admin, producer, processor, distributor, retailer, bond, lots } = await loadFixture(fixture);
    await bond.connect(producer).stakeBond({ value: ethers.parseEther("1") });
    const { qTree, pTree, totalWeight } = await buildTrees(lots);
    const sig = await signMerkle(admin, engine, 1, producer.address, qTree.root, pTree.root, totalWeight);
    await engine.initiateRecallMerkle(1, producer.address, qTree.root, pTree.root, totalWeight, sig);

    await time.increase(WINDOW + 1); // no challenge -> auto-upheld

    const share = ethers.parseEther("1") / 4n; // weight 1 of total 4 on a 1 ETH pot
    // lot 2 is held by the processor
    await expect(
      engine.claimPayout(1, 2, processor.address, 1, payoutProof(pTree, 2, processor.address, 1))
    ).to.changeEtherBalance(processor, share);
    // distributor holds lot 4, retailer holds lot 5
    await expect(
      engine.claimPayout(1, 4, distributor.address, 1, payoutProof(pTree, 4, distributor.address, 1))
    ).to.changeEtherBalance(distributor, share);

    // double claim of the same entry is rejected
    await expect(
      engine.claimPayout(1, 2, processor.address, 1, payoutProof(pTree, 2, processor.address, 1))
    ).to.be.revertedWith("already claimed");
  });
});
