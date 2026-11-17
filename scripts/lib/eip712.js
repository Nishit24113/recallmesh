/**
 * EIP-712 recall authorisations, matching RecallEngine's domain and typehashes.
 * The at-fault actor is NOT signed: the contract derives it from the provenance graph
 * (the root lot's producer). The lab certificate's IPFS CID is bound into the signature.
 */
const DOMAIN = { name: "RecallMesh", version: "1" };

const RECALL_TYPES = {
  Recall: [
    { name: "rootLotId", type: "uint256" },
    { name: "maxNodes", type: "uint256" },
    { name: "certificateCID", type: "string" },
  ],
};

const RECALL_MERKLE_TYPES = {
  RecallMerkle: [
    { name: "rootLotId", type: "uint256" },
    { name: "quarantineRoot", type: "bytes32" },
    { name: "payoutRoot", type: "bytes32" },
    { name: "totalWeight", type: "uint256" },
    { name: "certificateCID", type: "string" },
  ],
};

const domainFor = (engine, chainId) => ({ ...DOMAIN, chainId, verifyingContract: engine });

/** Sign an eager recall. `engine` is the RecallEngine address. */
function signRecall(signer, { engine, chainId, rootLotId, maxNodes, certificateCID }) {
  return signer.signTypedData(domainFor(engine, chainId), RECALL_TYPES, {
    rootLotId,
    maxNodes,
    certificateCID,
  });
}

/** Sign a Merkle-anchored recall. */
function signRecallMerkle(signer, { engine, chainId, rootLotId, quarantineRoot, payoutRoot, totalWeight, certificateCID }) {
  return signer.signTypedData(domainFor(engine, chainId), RECALL_MERKLE_TYPES, {
    rootLotId,
    quarantineRoot,
    payoutRoot,
    totalWeight,
    certificateCID,
  });
}

module.exports = { DOMAIN, RECALL_TYPES, RECALL_MERKLE_TYPES, domainFor, signRecall, signRecallMerkle };
