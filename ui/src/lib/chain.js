import { ethers } from "ethers";
import deployments from "../deployments.json";

export const isLocal = Number(deployments.chainId) === 31337;
export const SYMBOL = Number(deployments.chainId) === 80002 ? "POL" : "ETH";
export const ORACLE_URL = deployments.oracleUrl || "http://127.0.0.1:8787";
export const DEPLOY_BLOCK = Number(deployments.deployBlock || 0);

// Read straight from the node: MetaMask caches eth_getLogs/latest block on local chains.
// cacheTimeout -1: ethers otherwise reuses identical call results (incl. the block number)
// for a short window, so a refresh right after a tx could miss that tx's events.
export const reader = new ethers.JsonRpcProvider(deployments.rpcUrl, undefined, { staticNetwork: true, cacheTimeout: -1 });

export const fmt = (wei, dp = 4) => {
  const n = Number(ethers.formatEther(wei ?? 0n));
  if (n === 0) return "0";
  if (Math.abs(n) < 10 ** -dp) return "<" + (10 ** -dp).toFixed(dp); // rounding dust
  return n.toFixed(dp).replace(/\.?0+$/, "");
};

export const txUrl = (hash) => (deployments.explorer ? `${deployments.explorer}/tx/${hash}` : null);
export const addrUrl = (a) => (deployments.explorer ? `${deployments.explorer}/address/${a}` : null);

/**
 * All events of a contract since deployment. Public testnet RPCs cap eth_getLogs
 * ranges, so non-local chains are queried in chunks.
 */
export async function allEvents(c) {
  if (isLocal) return c.queryFilter("*", DEPLOY_BLOCK, "latest");
  const latest = Number(await reader.send("eth_blockNumber", []));
  const STEP = 9_000;
  const out = [];
  for (let from = DEPLOY_BLOCK; from <= latest; from += STEP + 1) {
    out.push(...(await c.queryFilter("*", from, Math.min(from + STEP, latest))));
  }
  return out;
}

/** Local chain only: jump past the dispute window so the demo needn't wait days. */
export async function advanceTime(seconds) {
  await reader.send("evm_increaseTime", [Math.max(1, Math.ceil(seconds))]);
  await reader.send("evm_mine", []);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
