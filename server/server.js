/**
 * server.js — Express bridge server
 *
 * Multi-board + Multi-LiDAR support.
 * Serves static files and provides API routes for board communication.
 * Runs LiDAR UDP→WebSocket proxies for real-time point clouds.
 *
 * Usage: node server.js [--port 3000]
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import boardApi from './board-api.js';
import { setupLidarProxy } from './lidar-proxy.js';
import { boards, lidars, defaultLidarWsPath } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api', boardApi);
app.use(express.static(ROOT));
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));

const port = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || process.env.PORT || '3000', 10);

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// Setup multi-LiDAR proxies
const lidar = setupLidarProxy(httpServer, wss, lidars, defaultLidarWsPath);

// Config API — boards & lidars list for frontend
app.get('/api/config', (req, res) => {
  res.json({ boards, lidars });
});

// LiDAR stats — all instances
app.get('/api/lidar/stats', (req, res) => {
  res.json(lidar.getStats());
});

// Single LiDAR stats (backward compat)
app.get('/api/lidar/stats/:id', (req, res) => {
  const inst = lidar.instances.find(i => i.id === req.params.id);
  if (!inst) return res.status(404).json({ error: 'LiDAR not found' });
  res.json(inst.getStats());
});

// Board list API
app.get('/api/boards', (req, res) => {
  res.json(boards);
});

// LiDAR traffic profile — observed timing analysis
app.get('/api/lidar/profile/:id', (req, res) => {
  const inst = lidar.instances.find(i => i.id === req.params.id);
  if (!inst) return res.status(404).json({ error: 'LiDAR not found' });
  const profile = inst.getTrafficProfile();
  if (!profile) return res.json({ error: 'Not enough data yet, wait a few seconds' });
  res.json(profile);
});

// Auto-generate TAS config from observed LiDAR traffic
app.get('/api/lidar/auto-tas/:id', (req, res) => {
  const inst = lidar.instances.find(i => i.id === req.params.id);
  if (!inst) return res.status(404).json({ error: 'LiDAR not found' });
  const opts = {};
  if (req.query.cycle) opts.cycleUs = parseInt(req.query.cycle);
  if (req.query.margin) opts.marginFactor = parseFloat(req.query.margin);
  const config = inst.generateTasConfig(opts);
  if (!config) return res.json({ error: 'Not enough data yet' });
  res.json(config);
});

// ── TAS Presets — common switch configurations ──
const TAS_PRESETS = [
  {
    id: 'lidar-auto', name: 'LiDAR Auto',
    desc: 'Auto-derived from LiDAR packet timing (1 pkt/cycle)',
    auto: true,
  },
  {
    id: 'lidar-safe', name: 'LiDAR Safe',
    desc: 'LiDAR TC7 with 4× margin for high-jitter environments',
    cycleUs: 3125,
    entries: [
      { gateStates: 128, durationUs: 109.8, note: 'TC7 LiDAR (4× margin)' },
      { gateStates: 0, durationUs: 2, note: 'guard' },
      { gateStates: 127, durationUs: 3036.2, note: 'BE' },
      { gateStates: 0, durationUs: 2, note: 'guard' },
    ],
  },
  {
    id: 'multi-sensor', name: 'Multi-Sensor',
    desc: 'LiDAR TC7 + Radar TC6 + Camera TC5 + BE',
    cycleUs: 3125,
    entries: [
      { gateStates: 128, durationUs: 55, note: 'TC7 LiDAR' },
      { gateStates: 0, durationUs: 1, note: 'guard' },
      { gateStates: 64, durationUs: 30, note: 'TC6 Radar' },
      { gateStates: 0, durationUs: 1, note: 'guard' },
      { gateStates: 32, durationUs: 20, note: 'TC5 Camera' },
      { gateStates: 0, durationUs: 1, note: 'guard' },
      { gateStates: 127, durationUs: 3042, note: 'BE' },
    ],
  },
  {
    id: 'strict-priority', name: 'Strict Priority',
    desc: 'TC7 highest priority, descending time allocation',
    cycleUs: 1000,
    entries: [
      { gateStates: 128, durationUs: 100, note: 'TC7' },
      { gateStates: 64, durationUs: 100, note: 'TC6' },
      { gateStates: 32, durationUs: 100, note: 'TC5' },
      { gateStates: 16, durationUs: 100, note: 'TC4' },
      { gateStates: 15, durationUs: 600, note: 'TC0-3 BE' },
    ],
  },
  {
    id: 'all-open', name: 'All Open (TAS Off)',
    desc: 'All gates open — no scheduling, best effort only',
    cycleUs: 1000,
    entries: [
      { gateStates: 255, durationUs: 1000, note: 'All open' },
    ],
  },
];

app.get('/api/tas/presets', (req, res) => {
  // If lidar-auto is requested, populate from live data
  const result = TAS_PRESETS.map(p => {
    if (p.auto) {
      const inst = lidar.instances[0];
      const tas = inst?.generateTasConfig();
      if (tas && !tas.error) {
        return { ...p, cycleUs: tas.cycleUs, entries: tas.entries };
      }
      return { ...p, cycleUs: null, entries: null, note: 'No LiDAR data' };
    }
    return p;
  });
  res.json(result);
});

// ── End-to-end benchmark: profile → auto-TAS → push to board ──
app.post('/api/lidar/benchmark/:id', async (req, res) => {
  const inst = lidar.instances.find(i => i.id === req.params.id);
  if (!inst) return res.status(404).json({ error: 'LiDAR not found' });

  const boardId = req.body.boardId || 'SW_REAR';
  const portNum = req.body.port || '1';
  const transport = req.body.transport || 'eth';
  const board = boards.find(b => b.id === boardId);
  if (!board) return res.status(404).json({ error: `Board not found: ${boardId}` });

  const timings = {};
  const t0 = process.hrtime.bigint();

  // Step 1: Get profile
  const profile = inst.getTrafficProfile();
  timings.profileMs = Number(process.hrtime.bigint() - t0) / 1e6;
  if (!profile) return res.json({ error: 'Not enough LiDAR data yet' });

  // Step 2: Generate TAS
  const t1 = process.hrtime.bigint();
  const tas = inst.generateTasConfig();
  timings.tasGenMs = Number(process.hrtime.bigint() - t1) / 1e6;
  if (!tas || tas.error) return res.json({ error: 'TAS generation failed', tas });

  // Step 3: Push to board via internal API call
  const t2 = process.hrtime.bigint();
  try {
    const pushBody = {
      port: portNum,
      cycleUs: tas.cycleUs,
      entries: tas.entries.map(e => ({ gateStates: e.gateStates, durationUs: e.durationUs })),
      transport,
      host: board.host,
    };

    // Use fetch to call our own push-port API
    const pushRes = await fetch(`http://localhost:${port}/api/gcl/push-port`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pushBody),
    });
    const pushResult = await pushRes.json();
    timings.boardPushMs = Number(process.hrtime.bigint() - t2) / 1e6;

    timings.totalMs = Number(process.hrtime.bigint() - t0) / 1e6;

    // Save benchmark result
    const result = {
      benchmarkedAt: new Date().toISOString(),
      lidarId: req.params.id,
      boardId,
      port: portNum,
      transport,
      timings: {
        profileMs: Math.round(timings.profileMs * 100) / 100,
        tasGenMs: Math.round(timings.tasGenMs * 100) / 100,
        boardPushMs: Math.round(timings.boardPushMs * 100) / 100,
        totalMs: Math.round(timings.totalMs * 100) / 100,
      },
      profile,
      autoTas: tas,
      pushResult,
    };

    const dataDir = path.join(ROOT, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const fname = `benchmark-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    fs.writeFileSync(path.join(dataDir, fname), JSON.stringify(result, null, 2));

    res.json({ saved: fname, ...result });
  } catch (e) {
    timings.boardPushMs = Number(process.hrtime.bigint() - t2) / 1e6;
    timings.totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
    res.status(500).json({ error: e.message, timings });
  }
});

// Capture LiDAR timing snapshot → save to data/ directory
app.post('/api/lidar/capture/:id', (req, res) => {
  const inst = lidar.instances.find(i => i.id === req.params.id);
  if (!inst) return res.status(404).json({ error: 'LiDAR not found' });
  const profile = inst.getTrafficProfile();
  const tas = inst.generateTasConfig();
  const timing = inst.getTimingSnapshot();
  if (!profile || !timing) return res.json({ error: 'Not enough data yet' });

  const capture = {
    capturedAt: new Date().toISOString(),
    sensor: 'Ouster OS-1-16 Gen1',
    lidarId: req.params.id,
    profile,
    autoTas: tas,
    timing,
  };

  const dataDir = path.join(ROOT, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const fname = `lidar-capture-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  const fpath = path.join(dataDir, fname);
  fs.writeFileSync(fpath, JSON.stringify(capture, null, 2));

  res.json({ saved: fname, profile, packets: timing.count });
});

// List saved captures
app.get('/api/lidar/captures', (req, res) => {
  const dataDir = path.join(ROOT, 'data');
  if (!fs.existsSync(dataDir)) return res.json([]);
  const files = fs.readdirSync(dataDir).filter(f => f.startsWith('lidar-capture-'));
  res.json(files);
});

// Get a saved capture
app.get('/api/lidar/captures/:file', (req, res) => {
  const fpath = path.join(ROOT, 'data', req.params.file);
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'Not found' });
  res.json(JSON.parse(fs.readFileSync(fpath, 'utf8')));
});

// ── TAS ON/OFF Comparison: measure jitter before and after TAS ──
app.post('/api/lidar/compare/:id', async (req, res) => {
  const inst = lidar.instances.find(i => i.id === req.params.id);
  if (!inst) return res.status(404).json({ error: 'LiDAR not found' });

  const boardId = req.body.boardId || 'SW_REAR';
  const portNum = req.body.port || '1';
  const board = boards.find(b => b.id === boardId);
  if (!board) return res.status(404).json({ error: `Board not found: ${boardId}` });

  const measureSec = req.body.measureSec || 5;

  const pushConfig = async (entries, cycleUs) => {
    const pushRes = await fetch(`http://localhost:${port}/api/gcl/push-port`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: portNum, cycleUs, entries, transport: 'eth', host: board.host, boardId }),
    });
    return pushRes.json();
  };

  const snapshot = () => {
    const profile = inst.getTrafficProfile();
    const timing = inst.getTimingSnapshot();
    if (!profile || !timing) return null;
    // Compute packet interval stats from raw timestamps
    const ints = timing.intervals_us;
    if (ints.length < 10) return null;
    const mean = ints.reduce((a, b) => a + b, 0) / ints.length;
    const sorted = [...ints].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(ints.length * 0.5)];
    const p95 = sorted[Math.floor(ints.length * 0.95)];
    const p99 = sorted[Math.floor(ints.length * 0.99)];
    const min = sorted[0], max = sorted[sorted.length - 1];
    const jitter = Math.sqrt(ints.reduce((s, v) => s + (v - mean) ** 2, 0) / ints.length);
    return {
      fps: profile.fps,
      pktIntervalUs: Math.round(mean * 100) / 100,
      jitterUs: Math.round(jitter * 100) / 100,
      minUs: Math.round(min * 100) / 100,
      maxUs: Math.round(max * 100) / 100,
      p50Us: Math.round(p50 * 100) / 100,
      p95Us: Math.round(p95 * 100) / 100,
      p99Us: Math.round(p99 * 100) / 100,
      rangeUs: Math.round((max - min) * 100) / 100,
      samples: ints.length,
    };
  };

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  try {
    const autoTas = inst.generateTasConfig();
    if (!autoTas || autoTas.error) return res.json({ error: 'No auto-TAS available' });

    const results = { boardId, port: portNum, measureSec };

    // Phase 1: TAS OFF (All Open)
    const offPush = await pushConfig(
      [{ gateStates: 255, durationUs: 1000 }], 1000
    );
    results.offPush = offPush;
    await wait(measureSec * 1000);
    results.off = snapshot();

    // Phase 2: TAS ON (Auto-derived)
    const onEntries = autoTas.entries.map(e => ({ gateStates: e.gateStates, durationUs: e.durationUs }));
    const onPush = await pushConfig(onEntries, autoTas.cycleUs);
    results.onPush = onPush;
    await wait(measureSec * 1000);
    results.on = snapshot();

    // Comparison
    if (results.off && results.on) {
      results.comparison = {
        jitterReduction: Math.round((1 - results.on.jitterUs / results.off.jitterUs) * 10000) / 100,
        rangeReduction: Math.round((1 - results.on.rangeUs / results.off.rangeUs) * 10000) / 100,
        p99Reduction: Math.round((results.off.p99Us - results.on.p99Us) * 100) / 100,
      };
    }

    results.autoTas = { cycleUs: autoTas.cycleUs, entries: autoTas.entries };
    results.completedAt = new Date().toISOString();

    // Save
    const dataDir = path.join(ROOT, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const fname = `compare-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    fs.writeFileSync(path.join(dataDir, fname), JSON.stringify(results, null, 2));
    results.saved = fname;

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

httpServer.listen(port, () => {
  console.log(`\n  KETI TSN Platform (Multi-Board)`);
  console.log(`  ────────────────────────────────`);
  console.log(`  Local:   http://localhost:${port}`);
  console.log(`  Dash:    http://localhost:${port}/dashboard.html`);
  console.log(`  Solver:  http://localhost:${port}/solver.html`);
  console.log(`  LiDAR:   http://localhost:${port}/lidar.html`);
  console.log(`  API:     http://localhost:${port}/api/config`);
  console.log();
  console.log(`  Boards:`);
  boards.forEach(b => console.log(`    ${b.id}: ${b.host}`));
  console.log();
});
