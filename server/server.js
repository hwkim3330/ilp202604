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
