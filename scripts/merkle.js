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

module.exports = { buildQuarantineTree, quarantineProof, buildPayoutTree, payoutProof };
