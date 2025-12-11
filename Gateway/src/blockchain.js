// Gateway/src/blockchain.js
/**
 * Robust blockchain helper for TrustLogger
 * - Loads Gateway/abi.json
 * - Supports ethers v5 and v6 shapes
 * - Creates provider + wallet (optional)
 * - Calls contract.logTrustEvent(groupId, oldTS, newTS, reason, dataHash, ts)
 *
 * Exports:
 *  - processAndLog(evt) -> { txHash, hash, success, error?, receipt? }
 *  - keccakHash(obj)
 *  - provider, wallet, contract
 */

require('dotenv').config();
const path = require('path');

let ethers;
try {
  ethers = require('ethers');
} catch (e) {
  console.error('[blockchain] Please install ethers (npm install ethers)');
  throw e;
}

const RPC = process.env.SEPOLIA_RPC_URL || process.env.RPC_URL || 'http://localhost:8545';
const PRIVATE_KEY = (process.env.DEPLOYER_PRIVATE_KEY || '').trim();
const CONTRACT_ADDR = (process.env.TRUSTLOGGER_ADDRESS || '').trim();
const ABI_PATH = path.join(__dirname, '..', 'abi.json');

let abi = null;
try {
  const raw = require(ABI_PATH);
  abi = Array.isArray(raw) ? raw : (raw.abi ? raw.abi : raw);
} catch (err) {
  console.warn('[blockchain] Warning: could not load ABI at', ABI_PATH, '; contract calls will be disabled.');
  abi = null;
}

/* ------------------ Provider (compat for v5/v6) ------------------ */
let provider;
try {
  // prefer ethers v6 style if present, else v5 style
  if (ethers.JsonRpcProvider) {
    provider = new ethers.JsonRpcProvider(RPC); // ethers v6
  } else if (ethers.providers && ethers.providers.JsonRpcProvider) {
    provider = new ethers.providers.JsonRpcProvider(RPC); // ethers v5
  } else if (typeof ethers.getDefaultProvider === 'function') {
    provider = ethers.getDefaultProvider(RPC);
  } else {
    throw new Error('No JsonRpcProvider available in installed ethers package');
  }
  console.log('[blockchain] Provider initialized for RPC:', RPC);
} catch (err) {
  console.error('[blockchain] Provider initialization failed:', err.message);
  throw err;
}

/* ------------------ Wallet (optional) ------------------ */
let wallet = null;
if (PRIVATE_KEY && PRIVATE_KEY !== '0x' && PRIVATE_KEY.length > 10) {
  try {
    // ethers v6: new ethers.Wallet(privateKey, provider)
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    console.log('[blockchain] Wallet created:', wallet.address || wallet._address || 'unknown');
  } catch (err) {
    console.error('[blockchain] Wallet creation failed:', err.message);
    wallet = null;
  }
} else {
  console.log('[blockchain] No DEPLOYER_PRIVATE_KEY present — running in read-only/test mode (no txs).');
}

/* ------------------ Contract instance ------------------ */
let contract = null;
if (abi && CONTRACT_ADDR) {
  try {
    const signerOrProvider = wallet || provider;
    contract = new ethers.Contract(CONTRACT_ADDR, abi, signerOrProvider);
    console.log('[blockchain] Contract instance ready at', CONTRACT_ADDR, wallet ? '(with signer)' : '(read-only)');
  } catch (err) {
    console.warn('[blockchain] Could not create contract instance:', err.message);
    contract = null;
  }
} else {
  console.log('[blockchain] Contract address or ABI missing — on-chain calls disabled.');
}

/* ------------------ Stable JSON stringify (deterministic) ------------------ */
function stableStringify(obj) {
  // handle primitives
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map((v) => stableStringify(v)).join(',') + ']';
  }
  // object: sort keys
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => {
    return JSON.stringify(k) + ':' + stableStringify(obj[k]);
  });
  return '{' + parts.join(',') + '}';
}

/* ------------------ Hash helper ------------------ */
function keccakHash(obj) {
  // Use deterministic JSON ordering to ensure same hash for same logical object
  const json = stableStringify(obj);

  // prefer ethers v6 helpers
  if (ethers.keccak256 && ethers.toUtf8Bytes) {
    return ethers.keccak256(ethers.toUtf8Bytes(json));
  }
  // fallback to ethers v5 utils
  if (ethers.utils && ethers.utils.keccak256 && ethers.utils.toUtf8Bytes) {
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(json));
  }
  // last resort: try requiring utils directly
  try {
    const { keccak256, toUtf8Bytes } = require('ethers/lib/utils');
    return keccak256(toUtf8Bytes(json));
  } catch (e) {
    throw new Error('keccak256/toUtf8Bytes not available in installed ethers package');
  }
}

/* ------------------ Main function: processAndLog ------------------ */
/**
 * evt expected shape (recommended):
 * {
 *   eventId, deviceId,
 *   groupId, oldTS, newTS, reason,
 *   distA, distB, speed,
 *   ts
 * }
 *
 * This function:
 *  - computes dataHash = keccak256(stableStringify(evt))
 *  - if contract+wallet present: calls contract.logTrustEvent(...)
 *  - returns structured info
 */
async function processAndLog(evt = {}) {
  try {
    // basic validation & defaulting
    const groupId = typeof evt.groupId === 'string' ? evt.groupId : (evt.deviceId || 'unknown-group');
    const oldTS = Number(evt.oldTS !== undefined ? evt.oldTS : (evt.oldTrustA ?? 0));
    const newTS = Number(evt.newTS !== undefined ? evt.newTS : (evt.newTrustA ?? 0));
    const reason = typeof evt.reason === 'string' ? evt.reason : (evt.reason || 'no-reason');

    // normalize ts to unix seconds
    let tsRaw = evt.ts !== undefined ? evt.ts : (evt.timestamp !== undefined ? evt.timestamp : Date.now());
    // if ts looks like milliseconds (greater than year 3000)
    if (tsRaw > 1e12) {
      tsRaw = Math.floor(tsRaw / 1000);
    } else {
      tsRaw = Math.floor(tsRaw);
    }
    const ts = tsRaw;

    // compute data hash
    const dataHash = keccakHash(evt);

    // If no contract or wallet, skip on-chain call but return the hash
    if (!contract || !wallet) {
      console.log('[blockchain] Skipping on-chain write (contract or wallet missing). dataHash:', dataHash);
      return { txHash: null, hash: dataHash, success: false, error: 'on-chain disabled' };
    }

    // Call contract function logTrustEvent(groupId, oldTS, newTS, reason, dataHash, ts)
    console.log('[blockchain] Calling contract.logTrustEvent with:', { groupId, oldTS, newTS, reason, dataHash, ts });

    // Send tx (works with ethers v5/v6)
    const tx = await contract.logTrustEvent(groupId, oldTS, newTS, reason, dataHash, ts);

    const txHash = tx.hash || tx.transactionHash || null;
    console.log('[blockchain] Tx sent:', txHash || tx);

    // wait for confirmation
    let receipt;
    try {
      receipt = await tx.wait();
    } catch (waitErr) {
      // Some providers behave differently; try provider.waitForTransaction fallback
      try {
        const hash = txHash;
        receipt = await provider.waitForTransaction(hash);
      } catch (pwErr) {
        // still failed
        console.warn('[blockchain] tx.wait failed and waitForTransaction failed:', waitErr.message || waitErr, pwErr && pwErr.message ? pwErr.message : pwErr);
      }
    }

    const confirmedHash = (receipt && (receipt.transactionHash || receipt.hash)) || txHash || null;
    console.log('[blockchain] Tx confirmed:', confirmedHash);

    return { txHash: confirmedHash, hash: dataHash, success: true, receipt };
  } catch (err) {
    console.error('[blockchain] processAndLog failed:', err && err.message ? err.message : String(err));
    // If we computed the hash before fail, return it; else null
    let maybeHash = null;
    try { maybeHash = keccakHash(evt); } catch (e) {}
    return { txHash: null, hash: maybeHash, success: false, error: (err && err.message) || String(err) };
  }
}

module.exports = {
  processAndLog,
  keccakHash,
  provider,
  wallet,
  contract
};
