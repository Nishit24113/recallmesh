/**
 * Shared test fixture: deploys + wires the system, registers actors, stakes bonds and
 * builds a multi-tier provenance DAG:
 *
 *        L1 (producer, raw, 100 units)
 *        /        \
 *      L2         L3        (processor, 50 + 50)
 *        \        /
 *          L4              (distributor, 40; diamond: reachable via L2 and L3)
 *          |
 *          L5              (retailer, 30)
 *
 *   L6 (producer, 10) -> L7 (processor, 5)   <-- unrelated branch, must stay unaffected
 *
 * With BOND_PER_UNIT = 0.01 ETH, L1 locks 1 ETH of the producer's bond, L2 0.5 ETH, etc.
 */
const { ethers } = require("hardhat");
const { deploySystem, Role, Status } = require("../scripts/lib/system.js");
const { signRecall, signRecallMerkle } = require("../scripts/lib/eip712.js");

const BOND_PER_UNIT = ethers.parseEther("0.01");
const CHALLENGE_WINDOW = 3 * 24 * 60 * 60; // RecallEngine default (3 days)
const LIABILITY_PERIOD = 30 * 24 * 60 * 60; // LiabilityBond default (30 days)
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

async function fixture() {
  const [admin, producer, processor, distributor, retailer, outsider] = await ethers.getSigners();
  const sys = await deploySystem(ethers, { admin, bondPerUnit: BOND_PER_UNIT }); // oracle = arbiter = admin
  const { actors, bond, lots } = sys;

  await actors.registerActor(producer.address, Role.Producer, "Farm");
  await actors.registerActor(processor.address, Role.Processor, "Mill");
  await actors.registerActor(distributor.address, Role.Distributor, "Dist");
  await actors.registerActor(retailer.address, Role.Retailer, "Store");

  await bond.connect(producer).stakeBond({ value: ethers.parseEther("2") });
  await bond.connect(processor).stakeBond({ value: ethers.parseEther("2") });
  await bond.connect(distributor).stakeBond({ value: ethers.parseEther("1") });
  await bond.connect(retailer).stakeBond({ value: ethers.parseEther("1") });

  await lots.connect(producer).createLot([], 100, "ipfs://L1"); // 1
  await lots.connect(processor).createLot([1], 50, "ipfs://L2"); // 2
  await lots.connect(processor).createLot([1], 50, "ipfs://L3"); // 3
  await lots.connect(distributor).createLot([2, 3], 40, "ipfs://L4"); // 4 (diamond)
  await lots.connect(retailer).createLot([4], 30, "ipfs://L5"); // 5
  await lots.connect(producer).createLot([], 10, "ipfs://L6"); // 6 (unrelated)
  await lots.connect(processor).createLot([6], 5, "ipfs://L7"); // 7 (unrelated)

  return { admin, producer, processor, distributor, retailer, outsider, ...sys };
}

async function chainId() {
  return (await ethers.provider.getNetwork()).chainId;
}

/** Oracle-signed eager recall of `rootLotId`, submitted by `admin` (the oracle). */
async function recallEager(engine, oracleSigner, rootLotId, certificateCID = CID, maxNodes = 50) {
  const sig = await signRecall(oracleSigner, {
    engine: await engine.getAddress(),
    chainId: await chainId(),
    rootLotId,
    maxNodes,
    certificateCID,
  });
  return engine.initiateRecall(rootLotId, maxNodes, certificateCID, sig);
}

async function signMerkle(oracleSigner, engine, rootLotId, quarantineRoot, payoutRoot, totalWeight, certificateCID = CID) {
  return signRecallMerkle(oracleSigner, {
    engine: await engine.getAddress(),
    chainId: await chainId(),
    rootLotId,
    quarantineRoot,
    payoutRoot,
    totalWeight,
    certificateCID,
  });
}

/** Expected per-entry shares, matching LiabilityBond.distributePayout (last absorbs dust). */
function expectedShares(pot, weights) {
  const total = weights.reduce((a, b) => a + b, 0n);
  let paid = 0n;
  return weights.map((w, i) => {
    const share = i === weights.length - 1 ? pot - paid : (pot * w) / total;
    paid += share;
    return share;
  });
}

module.exports = {
  fixture,
  recallEager,
  signMerkle,
  expectedShares,
  chainId,
  Role,
  Status,
  BOND_PER_UNIT,
  CHALLENGE_WINDOW,
  LIABILITY_PERIOD,
  CID,
};
