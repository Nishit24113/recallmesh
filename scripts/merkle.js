/**
 * Off-chain Merkle helpers for the scalable recall path. Uses OpenZeppelin's
 * StandardMerkleTree, whose leaf hashing (double-keccak of the ABI-encoded tuple)
 * matches MerkleProof.verify + our on-chain leaf construction in RecallEngine.
 *
 *  - quarantine tree:  leaves are (uint256 lotId)
 *  - payout tree:      leaves are (uint256 lotId, address holder, uint256 weight)
 */
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");

function buildQuarantineTree(lotIds) {
  const values = lotIds.map((id) => [BigInt(id).toString()]);
  return StandardMerkleTree.of(values, ["uint256"]);
}

function quarantineProof(tree, lotId) {
  for (const [i, v] of tree.entries()) {
    if (BigInt(v[0]) === BigInt(lotId)) return tree.getProof(i);
  }
  throw new Error("lot " + lotId + " not in quarantine tree");
}

function buildPayoutTree(entries) {
  // entries: [{ lotId, holder, weight }]
  const values = entries.map((e) => [BigInt(e.lotId).toString(), e.holder, BigInt(e.weight).toString()]);
  return StandardMerkleTree.of(values, ["uint256", "address", "uint256"]);
}

function payoutProof(tree, lotId, holder, weight) {
  for (const [i, v] of tree.entries()) {
    if (
      BigInt(v[0]) === BigInt(lotId) &&
      v[1].toLowerCase() === holder.toLowerCase() &&
      BigInt(v[2]) === BigInt(weight)
    ) {
      return tree.getProof(i);
    }
  }
  throw new Error("entry not in payout tree");
}

/**
 * Compute everything a Merkle-anchored recall of `rootLotId` needs, from chain state:
 *  - the affected descendant set (same BFS the eager path runs on-chain),
 *  - the payout table: one (lotId, holder, weight=balance) entry per holder with a
 *    non-zero balance, excluding the at-fault actor (the root lot's producer) — the same
 *    rule RecallEngine applies on-chain for eager recalls.
 * Returns null trees when there is nothing to commit (e.g. a leaf lot), in which case
 * the caller should use the eager path.
 */
async function buildRecallFromChain(lots, rootLotId, maxNodes = 4096) {
  const atFault = (await lots.producerOf(rootLotId)).toLowerCase();
  const affected = (await lots.affectedDescendants(rootLotId, maxNodes)).map(Number);
  const entries = [];
  for (const lotId of affected) {
    const [holders, balances] = await lots.holdingsOf(lotId);
    holders.forEach((holder, i) => {
      if (balances[i] > 0n && holder.toLowerCase() !== atFault) {
        entries.push({ lotId, holder, weight: balances[i] });
      }
    });
  }
  const totalWeight = entries.reduce((s, e) => s + BigInt(e.weight), 0n);
  const qTree = affected.length ? buildQuarantineTree(affected) : null;
  const pTree = entries.length ? buildPayoutTree(entries) : null;
  return { atFault, affected, entries, totalWeight, qTree, pTree };
}

module.exports = { buildQuarantineTree, quarantineProof, buildPayoutTree, payoutProof, buildRecallFromChain };
