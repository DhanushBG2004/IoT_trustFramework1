// Gateway/src/index.js
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

// system-level validator (your helper)
const { systemValidate } = require('./systemValidation');

// blockchain helper (must export provider, processAndLog, keccakHash, contract, wallet)
const blockchain = require('./blockchain');
const { provider, processAndLog, keccakHash, contract, wallet } = blockchain;

// ---- Config & paths ----
const PORT = process.env.PORT || 3000;
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'dhanushharini03080411';
const DEFAULT_THRESHOLD = Number(process.env.TRUST_THRESHOLD || 60);
const TRUSTLOGGER_ADDRESS = process.env.TRUSTLOGGER_ADDRESS || null;

const ROOT = path.join(__dirname, '..');
const EVENTS_FILE = path.join(ROOT, 'events.json');
const THRESHOLDS_FILE = path.join(ROOT, 'thresholds.json');

// ---- Minimal persistence helpers ----
function ensureEventsFile() {
  if (!fs.existsSync(EVENTS_FILE)) {
    fs.writeFileSync(EVENTS_FILE, '[]', 'utf8');
  }
}
function readEventsRaw() {
  ensureEventsFile();
  try {
    const raw = fs.readFileSync(EVENTS_FILE, 'utf8') || '[]';
    return JSON.parse(raw);
  } catch (e) {
    console.error('[storage] readEventsRaw failed:', e.message || e);
    return [];
  }
}
function appendEvent(evt) {
  try {
    ensureEventsFile();
    const arr = readEventsRaw();
    arr.push(evt);
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(arr, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[storage] appendEvent failed:', err && err.message ? err.message : err);
    return false;
  }
}

// per-group thresholds (simple file-backed map)
let thresholds = {};
function loadThresholds() {
  try {
    if (fs.existsSync(THRESHOLDS_FILE)) {
      thresholds = JSON.parse(fs.readFileSync(THRESHOLDS_FILE, 'utf8') || '{}');
    }
  } catch (e) {
    console.warn('[thresholds] load failed, using defaults', e.message);
    thresholds = {};
  }
}
function saveThresholds() {
  try {
    fs.writeFileSync(THRESHOLDS_FILE, JSON.stringify(thresholds, null, 2), 'utf8');
  } catch (e) {
    console.error('[thresholds] save failed', e.message);
  }
}
loadThresholds();

// ---- Express + Socket.io setup ----
const app = express();
app.use(express.json());
app.use(cors());

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Gateway running on port ${PORT}`);
});
const io = new Server(server, { cors: { origin: '*' } });
io.on('connection', (socket) => {
  console.log('[socket] Dashboard connected:', socket.id);
});

// ---- Utilities ----
function verifyApiKey(key) {
  if (!GATEWAY_API_KEY) return false;
  return key && key === GATEWAY_API_KEY;
}
function computeGroupThreshold(groupId) {
  return Number(thresholds[groupId] ?? DEFAULT_THRESHOLD);
}

// ---- Write queue for background on-chain logging ----
const writeQueue = [];
let processingQueue = false;

// Simple enqueue function
function enqueueChainLog(evt) {
  // push a shallow clone with attempt counter
  writeQueue.push({ item: evt, attempts: 0 });
  // persist queue entry for dev/audit
  appendEvent({ ...evt, queuedAt: new Date().toISOString(), stage: 'queued' });
  if (!processingQueue) {
    processQueue().catch(err => {
      console.error('[queue] processQueue top-level error:', err && err.message ? err.message : err);
    });
  }
}

// processQueue: sequential worker with retry/backoff
async function processQueue() {
  processingQueue = true;
  while (writeQueue.length > 0) {
    const wrapper = writeQueue.shift();
    const { item, attempts } = wrapper;
    const maxAttempts = 4;
    const nextAttempt = attempts + 1;
    try {
      console.log('[queue] Processing queued event:', item.eventId || item.payload && item.payload.eventId);
      // call processAndLog and wait for confirmation
      const result = await processAndLog(item);
      // append result to events and emit updates
      appendEvent({ ...item, blockchain: result, stage: 'post-chain', processedAt: new Date().toISOString() });
      io.emit('event_update', { ...item, blockchain: result, stage: 'final' });

      // emit flaggedEvent if flagged
      if (item.flagged) {
        const flaggedEventObj = {
          timestamp: item.payload.ts || Math.floor(Date.now() / 1000),
          eventId: item.eventId,
          deviceId: item.deviceId,
          groupId: item.groupId,
          distA: item.payload.distA ?? null,
          distB: item.payload.distB ?? null,
          trustA: item.oldTS ?? item.trustA ?? null,
          trustB: item.newTS ?? item.trustB ?? null,
          controller: item.payload.controller || (item.trustA >= item.trustB ? 'A' : 'B'),
          rpm: item.payload.rpm ?? (item.payload.speed ?? null),
          reason: item.reason || (item.payload && item.payload.reason) || 'LOW_TRUST',
          txHash: (result && (result.txHash || result.transactionHash)) || null,
          systemDecision: item.systemDecision || null
        };
        io.emit('flaggedEvent', flaggedEventObj);
      }

      console.log('[queue] Processed event', item.eventId, 'result:', result && result.success ? 'success' : 'failed');
      // small delay to avoid hammering the provider
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error('[queue] processing failed for event', item.eventId, 'attempt', nextAttempt, err && err.message ? err.message : err);
      if (nextAttempt < maxAttempts) {
        // exponential backoff before retrying: re-queue with incremented attempts
        const backoffMs = 1000 * Math.pow(2, nextAttempt); // 2s, 4s, 8s...
        console.log(`[queue] Re-queueing event ${item.eventId} after ${backoffMs}ms (attempt ${nextAttempt}/${maxAttempts})`);
        // push back to queue end with incremented attempts counter
        writeQueue.push({ item, attempts: nextAttempt });
        // wait backoff before continuing loop (prevents busy spin)
        await new Promise(r => setTimeout(r, backoffMs));
      } else {
        // give up after maxAttempts - persist failure and notify dashboard
        console.error(`[queue] Giving up on event ${item.eventId} after ${nextAttempt} attempts`);
        appendEvent({ ...item, stage: 'post-chain-failed', error: err && err.message ? err.message : String(err), processedAt: new Date().toISOString() });
        io.emit('event_update', { ...item, stage: 'post-chain-failed', error: err && err.message ? err.message : String(err) });
      }
    }
  } // while queue
  processingQueue = false;
}

// ---- Health route ----
app.get('/', (req, res) => res.send('Gateway is running...'));

// ---- Main /data handler ----
app.post('/data', async (req, res) => {
  try {
    // 1) API key check
    const apiKey = req.headers['x-api-key'] || req.headers['X-API-KEY'];
    if (!verifyApiKey(apiKey)) {
      return res.status(401).json({ error: 'invalid api key' });
    }

    // 2) Payload & basic logging
    const payload = req.body || {};
    console.log('[event] received payload:', payload);

    // 3) Compute data hash (keccak256 of JSON string)
    let dataHash = null;
    try {
      dataHash = keccakHash(payload);
    } catch (e) {
      // fallback to ethers utils if needed
      try {
        const { keccak256, toUtf8Bytes } = require('ethers/lib/utils');
        dataHash = keccak256(toUtf8Bytes(JSON.stringify(payload)));
      } catch (ee) {
        console.error('[hash] hash compute failed', ee.message || ee);
      }
    }
    console.log('[event] dataHash:', dataHash);

    // 4) Local threshold check
    const groupId = (payload.groupId && String(payload.groupId)) || (payload.deviceId && String(payload.deviceId)) || 'group-1';
    const deviceId = payload.deviceId || 'unknown';

    const trustA = (payload.trustA !== undefined) ? Number(payload.trustA) : 100;
    const trustB = (payload.trustB !== undefined) ? Number(payload.trustB) : 100;
    const groupThreshold = computeGroupThreshold(groupId);

    const localFlagged = (trustA < groupThreshold) || (trustB < groupThreshold);

    // 5) Build storedEvent and persist initial record
    const eventId = payload.eventId || `evt-${Date.now()}`;
    let storedEvent = {
      eventId,
      deviceId,
      groupId,
      payload,
      dataHash,
      trustA,
      trustB,
      localFlagged,
      receivedAt: new Date().toISOString()
    };
    appendEvent({ ...storedEvent, stage: 'received' });

    // 6) Emit arrival to frontend/dashboard (telemetry)
    io.emit('event_update', { ...storedEvent, stage: 'received' });
    const telemetryPayload = {
      timestamp: storedEvent.payload.ts || Math.floor(Date.now()/1000),
      distA: storedEvent.payload.distA ?? null,
      distB: storedEvent.payload.distB ?? null,
      trustA: storedEvent.trustA,
      trustB: storedEvent.trustB,
      controller: storedEvent.payload.controller || (storedEvent.trustA >= storedEvent.trustB ? 'A' : 'B'),
      rpm: storedEvent.payload.rpm ?? (storedEvent.payload.speed ?? null),
      hash: storedEvent.dataHash ?? null,
      flagged: storedEvent.localFlagged || false,
      deviceId: storedEvent.deviceId,
      groupId: storedEvent.groupId
    };
    io.emit('telemetry', telemetryPayload);

    // 7) SYSTEM-LEVEL VALIDATION (historical analysis + decision)
    let systemDecision = { action: 'no_action' };
    try {
      // pass provider + contract address to validation helper
      systemDecision = await systemValidate(provider, TRUSTLOGGER_ADDRESS, groupId, deviceId);
      storedEvent.systemDecision = systemDecision;
      appendEvent({ ...storedEvent, stage: 'system-validation' });
      io.emit('event_update', { ...storedEvent, stage: 'system-validation' });

      // act on systemDecision (affects storedEvent metadata)
      if (systemDecision.action === 'confirm_unreliable') {
        storedEvent.systemFlag = 'confirmed_unreliable';
        storedEvent.flagged = true;
        io.emit('system_alert', { deviceId, groupId, decision: systemDecision });
      } else if (systemDecision.action === 'adjust_threshold_lower') {
        const newThreshold = Number(systemDecision.newThreshold || groupThreshold);
        thresholds[groupId] = newThreshold;
        saveThresholds();
        storedEvent.thresholdChanged = newThreshold;
        io.emit('threshold_update', { groupId, newThreshold });
      } else if (systemDecision.action === 'flag_for_review') {
        io.emit('system_alert', { deviceId, groupId, decision: systemDecision });
      }
    } catch (err) {
      console.warn('[systemValidation] error (continuing):', err && err.message ? err.message : err);
      systemDecision = { action: 'validation_error', error: err && err.message ? err.message : String(err) };
      storedEvent.systemDecision = systemDecision;
      appendEvent({ ...storedEvent, stage: 'system-validation-error' });
    }

    // 8) Combine decisions (local OR system-confirmed unreliable)
    const finalFlagged = storedEvent.flagged || localFlagged || (systemDecision && systemDecision.action === 'confirm_unreliable');
    storedEvent.flagged = !!finalFlagged;

    // persist pre-chain record
    appendEvent({ ...storedEvent, stage: 'pre-chain' });
    io.emit('event_update', { ...storedEvent, stage: 'pre-chain' });

    // 9) If not flagged by any logic -> return early with systemDecision for transparency
    if (!finalFlagged) {
      return res.json({
        message: 'Data received (not flagged)',
        hash: dataHash,
        flagged: false,
        systemDecision
      });
    }

    // 10) Prepare contract arguments (map fields)
    const oldTS = Number(payload.oldTS ?? payload.oldTrustA ?? trustA);
    const newTS = Number(payload.newTS ?? payload.newTrustA ?? trustB);
    const reason = String(payload.reason || (systemDecision && systemDecision.reason) || 'LOW_TRUST');
    const ts = Math.floor((payload.ts || payload.timestamp || Date.now()) / 1000);

    // 11) ENQUEUE for background on-chain logging and respond immediately
    const queueItem = {
      eventId,
      deviceId,
      groupId,
      oldTS,
      newTS,
      reason,
      dataHash,
      ts,
      payload,
      trustA,
      trustB,
      flagged: true,
      systemDecision
    };

    enqueueChainLog(queueItem);

    // immediate response (fast)
    const feedback = {
      action: systemDecision && systemDecision.action ? systemDecision.action : 'no_action',
      reason: systemDecision && systemDecision.reason ? systemDecision.reason : null,
      adjustThreshold: systemDecision && systemDecision.newThreshold ? systemDecision.newThreshold : null
    };

    return res.json({
      message: 'Flagged event accepted and queued for on-chain logging',
      hash: dataHash,
      flagged: true,
      systemDecision,
      feedback
    });

  } catch (err) {
    console.error('[/data] handler error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server error', details: err && err.message ? err.message : String(err) });
  }
});

// ---- Optional: expose simple admin endpoints ----
// Get recent events (read-only)
app.get('/events/recent', (req, res) => {
  try {
    const arr = readEventsRaw();
    const recent = arr.slice(-200).reverse(); // last 200 entries, newest first
    return res.json({ count: recent.length, events: recent });
  } catch (e) {
    return res.status(500).json({ error: 'could not read events', details: e.message });
  }
});

// Get flagged events (recent)
app.get('/flagged-events', (req, res) => {
  try {
    const arr = readEventsRaw();
    const flagged = arr
      .filter(e => e.flagged)
      .slice(-200)
      .reverse()
      .map(e => ({
        timestamp: e.payload && e.payload.ts ? e.payload.ts : (e.receivedAt ? new Date(e.receivedAt).getTime() : Date.now()),
        eventId: e.eventId,
        deviceId: e.deviceId,
        groupId: e.groupId,
        distA: e.payload && e.payload.distA,
        distB: e.payload && e.payload.distB,
        trustA: e.trustA,
        trustB: e.trustB,
        controller: e.payload && e.payload.controller ? e.payload.controller : (e.trustA >= e.trustB ? 'A' : 'B'),
        rpm: e.payload && (e.payload.rpm || e.payload.speed),
        reason: e.payload && e.payload.reason,
        txHash: e.blockchain && (e.blockchain.txHash || e.blockchain.transactionHash),
        systemDecision: e.systemDecision || null
      }));
    res.json(flagged);
  } catch (err) {
    res.status(500).json({ error: 'could not read events', details: err.message });
  }
});

// Get current thresholds
app.get('/thresholds', (req, res) => res.json({ thresholds, default: DEFAULT_THRESHOLD }));
