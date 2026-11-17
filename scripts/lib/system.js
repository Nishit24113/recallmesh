/**
 * Deploys and wires the five RecallMesh contracts. Shared by deploy.js, demo.js, the
 * benchmarks and the tests so the wiring lives in one place.
 *
 *   const sys = await deploySystem(hre.ethers, { admin, oracle, arbiter, bondPerUnit });
 *
 * `oracle` / `arbiter` are addresses (default: admin). Every config transaction is
 * awaited so this also works on a real network.
 */
async function deploySystem(ethers, opts = {}) {
  const admin = opts.admin || (await ethers.getSigners())[0];
  const a = admin.address;
  const oracle = opts.oracle || a;
  const arbiter = opts.arbiter || a;
  const bondPerUnit = opts.bondPerUnit ?? ethers.parseEther("0.01");

  const deploy = async (name, args) => {
    const c = await ethers.deployContract(name, args, admin);
    await c.waitForDeployment();
    return c;
  };
  const send = async (p) => (await p).wait();

  const actors = await deploy("ActorRegistry", [a]);
  const bond = await deploy("LiabilityBond", [a]);
  const disputes = await deploy("DisputeModule", [arbiter, a]);
  const lots = await deploy("LotRegistry", [await actors.getAddress(), a]);
  const engine = await deploy("RecallEngine", [
    await lots.getAddress(),
    await bond.getAddress(),
    await disputes.getAddress(),
    await actors.getAddress(),
    oracle,
    a,
  ]);

  const engineAddr = await engine.getAddress();
  await send(lots.setRecallEngine(engineAddr));
  await send(lots.setBond(await bond.getAddress()));
  await send(bond.setRecallEngine(engineAddr));
  await send(bond.setLotRegistry(await lots.getAddress()));
  await send(disputes.setRecallEngine(engineAddr));
  if (bondPerUnit > 0n) await send(bond.setBondPerUnit(bondPerUnit));
  if (opts.liabilityPeriod != null) await send(bond.setLiabilityPeriod(opts.liabilityPeriod));
  if (opts.challengeWindow != null) await send(engine.setChallengeWindow(opts.challengeWindow));

  return { actors, bond, disputes, lots, engine };
}

const Role = { None: 0, Producer: 1, Supplier: 2, Processor: 3, Distributor: 4, Retailer: 5, Regulator: 6 };
const Status = { Active: 0, Quarantined: 1, Recalled: 2 };
const StatusName = ["Active", "Quarantined", "Recalled"];

module.exports = { deploySystem, Role, Status, StatusName };
