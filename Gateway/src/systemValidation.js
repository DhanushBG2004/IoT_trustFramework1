// Gateway/src/systemValidation.js
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const EVENTS_FILE = path.join(__dirname, '..', 'events.json');
const CONTRACT = require('../abi.json'); // ABI (array or { abi: [...] } accepted)

// config tunables (adjust if you want)
const WINDOW_EVENTS = 20;
const DROP_DELTA = 10;        // significant drop if newTS decreases by >= this
const INSTABILITY_DELTA = 8;  // large fluctuation threshold
const DROP_COUNT_THRESHOLD = 3;
const INSTABILITY_FRACTION = 0.4;
const LOOKBACK_BLOCKS = 50_000; // when querying on-chain logs; tune for time range

/**
 * Fetch TrustEvent logs from chain (ethers v6 compatible)
 * @param {ethers.Provider} provider
 * @param {string} contractAddress
 * @param {string} groupId
 * @param {number|null} fromBlock
 * @returns {Promise<Array>}
 */
async function fetchOnChainTrustEvents(provider, contractAddress, groupId, fromBlock = null) {
  if (!provider || !contractAddress) return [];

  // Ensure we have an ABI usable by ethers.Interface
  const iface = new ethers.Interface(CONTRACT);

  // Get the event fragment and its topic (ethers v6)
  const eventFragment = iface.getEvent('TrustEvent');
  const topic0 = eventFragment.topicHash; // event signature topic

  // For indexed string parameter, topic is keccak256(utf8Bytes(value))
  const topic1 = ethers.keccak256(ethers.toUtf8Bytes(String(groupId)));

  // compute fromBlock safely
  let targetFromBlock = fromBlock;
  try {
    const current = await provider.getBlockNumber();
    const fallback = Math.max(0, current - LOOKBACK_BLOCKS);
    targetFromBlock = (typeof fromBlock === 'number' && fromBlock >= 0) ? fromBlock : fallback;
  } catch (err) {
    // if provider.getBlockNumber fails, fall back to undefined (provider will use default)
    console.warn('[systemValidation] provider.getBlockNumber failed, using default fromBlock', err && err.message ? err.message : err);
    targetFromBlock = undefined;
  }

  const filter = {
    address: contractAddress,
    topics: [topic0, topic1],
    fromBlock: targetFromBlock
  };

  let logs = [];
  try {
    logs = await provider.getLogs(filter);
  } catch (err) {
    // bubble up for caller to handle
    throw new Error(`getLogs failed: ${err && err.message ? err.message : String(err)}`);
  }

  // parse logs into friendly objects
  const parsed = logs.map((log) => {
    try {
      // parseLog expects an object with topics/data (log usually has these)
      const decoded = iface.parseLog(log);
      // decoded.args may be BigInt/BigNumber — coerce safely
      const safeNum = (v) => {
        try {
          // ethers v6 may return BigInt or Number-like; convert to Number where safe
          if (typeof v === 'bigint') return Number(v);
          if (v && typeof v.toNumber === 'function') return v.toNumber();
          return Number(v);
        } catch (e) {
          return Number(String(v));
        }
      };

      return {
        groupId: decoded.args.groupId,
        oldTS: safeNum(decoded.args.oldTS),
        newTS: safeNum(decoded.args.newTS),
        reason: decoded.args.reason,
        dataHash: decoded.args.dataHash,
        ts: safeNum(decoded.args.ts),
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        source: 'onchain'
      };
    } catch (e) {
      // parsing failure — return minimal info
      return {
        groupId: groupId,
        oldTS: null,
        newTS: null,
        reason: null,
        dataHash: null,
        ts: null,
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        source: 'onchain_parse_error',
        _raw: { topics: log.topics, data: log.data }
      };
    }
  });

  // filter out items without ts and sort by ts where possible
  const withTs = parsed.filter(p => p.ts !== null && !Number.isNaN(p.ts));
  const withoutTs = parsed.filter(p => p.ts === null || Number.isNaN(p.ts));
  const sorted = withTs.sort((a,b) => a.ts - b.ts).concat(withoutTs);
  return sorted;
}

/**
 * Read local events.json and extract events relevant to group/device
 */
function readLocalEventsForGroup(groupId, deviceId) {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return [];
    const raw = fs.readFileSync(EVENTS_FILE, 'utf8');
    const arr = JSON.parse(raw || '[]');

    const hits = arr
      .filter(e =>
        // match by payload.groupId or payload.deviceId or top-level groupId
        (e.payload && (e.payload.groupId === groupId || e.payload.deviceId === deviceId)) ||
        e.groupId === groupId
      )
      .map(e => {
        // prefer payload values when present; fallback to outer fields
        const oldTS = Number((e.payload && (e.payload.oldTS ?? e.payload.oldTrustA)) ?? (e.oldTS ?? 100));
        const newTS = Number((e.payload && (e.payload.newTS ?? e.payload.newTrustA)) ?? (e.newTS ?? 100));
        const ts = e.payload && e.payload.ts ? Number(e.payload.ts) :
                   e.receivedAt ? Math.floor(new Date(e.receivedAt).getTime()/1000) : Date.now()/1000;
        return {
          groupId: (e.payload && e.payload.groupId) || e.groupId,
          oldTS,
          newTS,
          reason: (e.payload && e.payload.reason) || e.reason || 'LOCAL',
          ts,
          source: 'local'
        };
      });

    return hits.sort((a,b) => a.ts - b.ts);
  } catch (err) {
    console.error('[systemValidation] readLocalEventsForGroup error', err && err.message ? err.message : err);
    return [];
  }
}

/**
 * Build merged time series combining on-chain and local events (newest last)
 */
async function buildTrustSeries(provider, contractAddress, groupId, deviceId) {
  const local = readLocalEventsForGroup(groupId, deviceId);
  let onchain = [];
  try {
    if (provider && contractAddress) {
      onchain = await fetchOnChainTrustEvents(provider, contractAddress, groupId);
    }
  } catch (err) {
    console.warn('[systemValidation] on-chain fetch failed', err && err.message ? err.message : err);
    onchain = [];
  }

  // Prefer ordering by timestamp, prefer local when timestamps match (merge)
  const merged = [...onchain, ...local].sort((a,b) => (a.ts || 0) - (b.ts || 0));

  // dedupe by ts+groupId if necessary (keep local if duplicate)
  const deduped = [];
  const seen = new Set();
  for (const item of merged) {
    const key = `${item.groupId || ''}:${item.ts || 0}:${item.source || ''}`;
    // allow duplicates but try to avoid exact timestamp duplicates (prefer local)
    if (!seen.has(`${item.groupId || ''}:${item.ts || 0}`)) {
      deduped.push(item);
      seen.add(`${item.groupId || ''}:${item.ts || 0}`);
    } else {
      // if we already had an onchain entry and this is local, replace it
      if (item.source === 'local') {
        // find index and replace
        const idx = deduped.findIndex(d => d.groupId === item.groupId && d.ts === item.ts);
        if (idx >= 0) deduped[idx] = item;
      }
    }
  }

  // return last WINDOW_EVENTS
  if (deduped.length <= WINDOW_EVENTS) return deduped;
  return deduped.slice(deduped.length - WINDOW_EVENTS);
}

/**
 * Analyze series: drops, instability fraction, slope
 */
function analyzeSeries(series) {
  if (!series || series.length < 2) return { ok: false, reason: 'insufficient_samples' };

  let drops = 0;
  let instabilityCount = 0;
  const points = [];

  for (let i = 1; i < series.length; i++) {
    const prev = (series[i-1].newTS !== undefined && series[i-1].newTS !== null) ? Number(series[i-1].newTS) : Number(series[i-1].oldTS);
    const cur = (series[i].newTS !== undefined && series[i].newTS !== null) ? Number(series[i].newTS) : Number(series[i].oldTS);
    if (Number.isNaN(prev) || Number.isNaN(cur)) continue;
    const delta = cur - prev;
    if (delta <= -DROP_DELTA) drops++;
    if (Math.abs(delta) >= INSTABILITY_DELTA) instabilityCount++;
    points.push({ x: i, y: cur });
  }

  const sampleCount = Math.max(1, points.length);
  const instabilityFrac = instabilityCount / sampleCount;

  // simple least-squares slope
  let slope = 0;
  if (points.length >= 2) {
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const p of points) {
      sumX += p.x;
      sumY += p.y;
      sumXY += p.x * p.y;
      sumXX += p.x * p.x;
    }
    const n = points.length;
    const denom = (n * sumXX - sumX * sumX);
    if (denom !== 0) slope = (n * sumXY - sumX * sumY) / denom;
    else slope = 0;
  }

  return {
    ok: true,
    drops,
    instabilityFrac,
    slope,
    samples: series.length
  };
}

/**
 * Public API: systemValidate
 * provider and contractAddress are optional; if on-chain fetch fails we fallback to local events only.
 */
async function systemValidate(provider, contractAddress, groupId, deviceId) {
  try {
    const series = await buildTrustSeries(provider, contractAddress, groupId, deviceId);
    const analysis = analyzeSeries(series);
    if (!analysis.ok) return { action: 'insufficient_data', analysis };

    // Decision rules (simple, tune to taste)
    if (analysis.drops >= DROP_COUNT_THRESHOLD && analysis.samples >= 6) {
      return { action: 'confirm_unreliable', reason: 'recurring_drops', analysis };
    }
    if (analysis.instabilityFrac >= INSTABILITY_FRACTION) {
      return { action: 'flag_for_review', reason: 'high_instability', analysis };
    }
    if (analysis.slope < -2) {
      // downward trend detected; suggest adjusting threshold slightly downward (example)
      return { action: 'adjust_threshold_lower', reason: 'downward_trend', analysis, newThreshold: Math.max(10, TRUST_THRESHOLD - 5) };
    }
    return { action: 'no_action', analysis };
  } catch (err) {
    console.error('[systemValidation] top-level error', err && err.message ? err.message : err);
    return { action: 'validation_error', error: err && err.message ? err.message : String(err) };
  }
}

module.exports = { systemValidate, buildTrustSeries, analyzeSeries, readLocalEventsForGroup, fetchOnChainTrustEvents };
