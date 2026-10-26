/**
 * Test skeleton for RecallMesh. Deliverable-2 stage: a couple of basic structural
 * tests pass today; the full recall-flow tests are stubbed (describe/it.skip) and
 * filled in during the implementation milestone.
 */
const { expect } = require("chai");
const hre = require("hardhat");

const Role = { None: 0, Producer: 1, Supplier: 2, Processor: 3, Distributor: 4, Retailer: 5, Regulator: 6 };

async function deployAll() {
  const [admin, producer, retailer] = await hre.ethers.getSigners();
  const a = admin.address;

  const actors = await hre.ethers.deployContract("ActorRegistry", [a]);
  const bond = await hre.ethers.deployContract("LiabilityBond", [a]);
  const disputes = await hre.ethers.deployContract("DisputeModule", [a, a]);
  const lots = await hre.ethers.deployContract("LotRegistry", [await actors.getAddress(), a]);
  const engine = await hre.ethers.deployContract("RecallEngine", [
    await lots.getAddress(),
    await bond.getAddress(),
    await disputes.getAddress(),
    await actors.getAddress(),
    a,
    a,
  ]);
  await lots.setRecallEngine(await engine.getAddress());
  await bond.setRecallEngine(await engine.getAddress());
  await disputes.setRecallEngine(await engine.getAddress());
  return { admin, producer, retailer, actors, bond, disputes, lots, engine };
}

describe("RecallMesh — structural draft", function () {
  it("deploys and wires all five contracts", async function () {
    const { engine, lots } = await deployAll();
    expect(await lots.recallEngine()).to.equal(await engine.getAddress());
  });

  it("registers an actor and creates a lot in the DAG", async function () {
    const { actors, lots, producer } = await deployAll();
    await actors.registerActor(producer.address, Role.Producer, "Farm A");
    expect(await actors.isActive(producer.address)).to.equal(true);

    await lots.connect(producer).createLot([], 100, "ipfs://cert-root");
    const lot = await lots.getLot(1);
    expect(lot.producer).to.equal(producer.address);
  });

  it("stakes and reports a liability bond", async function () {
    const { bond, producer } = await deployAll();
    await bond.connect(producer).stakeBond({ value: hre.ethers.parseEther("1") });
    expect(await bond.bondOf(producer.address)).to.equal(hre.ethers.parseEther("1"));
  });
});

// TODO (implementation milestone): full recall flow.
describe.skip("RecallMesh — recall flow", function () {
  it("quarantines the exact affected descendant set from a recalled root", async function () {});
  it("verifies the EIP-712 oracle signature and rejects forgeries", async function () {});
  it("slashes the at-fault bond into escrow and pays downstream holders pro-rata", async function () {});
  it("lets an accused actor challenge within the dispute window", async function () {});
});
