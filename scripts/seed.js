/**
 * Seed a deployed RecallMesh with a demo supply chain: registers four actors, stakes
 * their bonds, publishes lot metadata to IPFS and builds a provenance DAG with a
 * diamond and an unrelated branch, then moves some stock downstream.
 *
 *   npx hardhat run scripts/seed.js --network localhost
 *   npx hardhat run scripts/seed.js --network amoy
 *
 * Local: actors are Hardhat accounts #3-#6 (#1 is the oracle service's key).
 * Testnet: actor wallets are generated once into deployments/<network>-actors.json
 * (gitignored — it holds private keys) and funded from the deployer with
 * bond + SEED_GAS_FUND (default 0.03 POL each).
 *
 * DAG:   L1 Raw spinach (Farm) ─┐
 *                               ├─ L3 Washed spinach (Mill) ─┐
 *        L2 Romaine (Farm) ─────┼────────────────────────────┴─ L4 Spring mix (Mill) ─ L5 Salad pallet (Dist) ─ L6 Shelf packs (Store)
 *        L7 Kale (Farm) ── L8 Kale chips (Mill)               (unrelated branch)
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { Role } = require("./lib/system.js");
const { putJSON } = require("../offchain/ipfs.js");

const ACTORS = [
  { key: "farm", name: "GreenField Farm", role: Role.Producer },
  { key: "mill", name: "FreshWash Processing", role: Role.Processor },
  { key: "dist", name: "ColdChain Distribution", role: Role.Distributor },
  { key: "store", name: "City Grocer", role: Role.Retailer },
];

// [producer key, name, parents, quantity, unit]
const LOTS = [
  ["farm", "Raw spinach", [], 100, "kg"],
  ["farm", "Romaine lettuce", [], 60, "kg"],
  ["mill", "Washed spinach", [1], 80, "kg"],
  ["mill", "Spring salad mix", [3, 2], 70, "bags"],
  ["dist", "Salad pallet", [4], 50, "bags"],
  ["store", "Shelf packs", [5], 40, "packs"],
  ["farm", "Kale", [], 30, "kg"],
  ["mill", "Kale chips", [7], 20, "bags"],
];

async function actorWallets(ethers, network, deployer) {
  if (["hardhat", "localhost"].includes(network.name)) {
    const s = await ethers.getSigners();
    return Object.fromEntries(ACTORS.map((a, i) => [a.key, s[3 + i]]));
  }
  const file = path.join(__dirname, "..", "deployments", `${network.name}-actors.json`);
  let keys;
  if (fs.existsSync(file)) {
    keys = JSON.parse(fs.readFileSync(file, "utf8"));
  } else {
    keys = Object.fromEntries(ACTORS.map((a) => [a.key, ethers.Wallet.createRandom().privateKey]));
    fs.writeFileSync(file, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
    console.log(`Generated actor keys -> deployments/${network.name}-actors.json (keep private)`);
  }
  return Object.fromEntries(Object.entries(keys).map(([k, pk]) => [k, new ethers.Wallet(pk, deployer.provider)]));
}

async function main() {
  const { ethers, network } = hre;
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const [deployer] = await ethers.getSigners();
  const at = (name) => ethers.getContractAt(name, d[name], deployer);
  const actors = await at("ActorRegistry");
  const bond = await at("LiabilityBond");
  const lots = await at("LotRegistry");
  const send = async (p) => (await p).wait();

  if ((await lots.lotCount()) > 0n) {
    console.log("LotRegistry already has lots — skipping seed (redeploy for a fresh chain).");
    return;
  }

  const w = await actorWallets(ethers, network, deployer);
  const bondPerUnit = BigInt(d.bondPerUnit);
  const unitsBy = {};
  for (const [k, , , q] of LOTS) unitsBy[k] = (unitsBy[k] || 0n) + BigInt(q);
  const gasFund = ethers.parseEther(process.env.SEED_GAS_FUND || "0.03");

  for (const a of ACTORS) {
    const wallet = w[a.key];
    const stake = (unitsBy[a.key] * bondPerUnit * 3n) / 2n; // 1.5x what its lots will lock
    if (!["hardhat", "localhost"].includes(network.name)) {
      const need = stake + gasFund;
      const have = await ethers.provider.getBalance(wallet.address);
      if (have < need) {
        await send(deployer.sendTransaction({ to: wallet.address, value: need - have }));
        console.log(`Funded ${a.name} ${wallet.address} with ${ethers.formatEther(need - have)}`);
      }
    }
    await send(actors.registerActor(wallet.address, a.role, a.name));
    await send(bond.connect(wallet).stakeBond({ value: stake }));
    console.log(`Registered ${a.name.padEnd(24)} ${wallet.address}  staked ${ethers.formatEther(stake)}`);
  }

  for (const [i, [k, name, parents, qty, unit]] of LOTS.entries()) {
    const meta = await putJSON(
      { type: "RecallMesh/LotMetadata", name, quantity: qty, unit, producer: ACTORS.find((a) => a.key === k).name },
      `lot-${i + 1}.json`
    );
    await send(lots.connect(w[k]).createLot(parents, qty, meta.uri));
    console.log(`L${i + 1} ${name.padEnd(18)} by ${k.padEnd(5)} parents [${parents}]  ${meta.uri}`);
  }

  // Move some stock downstream so a recall pays several holders.
  await send(lots.connect(w.mill).transferCustody(4, w.dist.address, 20));
  await send(lots.connect(w.dist).transferCustody(5, w.store.address, 20));
  console.log("Moved 20 bags of L4 Mill->Dist and 20 bags of L5 Dist->Store");
  console.log("\nSeeded. Next: node offchain/oracle.js, then open the UI.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
