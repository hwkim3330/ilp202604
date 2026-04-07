/**
 * server.js — Express bridge server
 *
 * Serves static files (solver.html, js/, vendor/) and provides
 * API routes for LAN9662 board communication.
 * Also runs LiDAR UDP→WebSocket proxy for real-time point cloud.
 *
 * Usage: node server.js [--port 3000] [--device /dev/ttyACM0]
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import boardApi from './board-api.js';
import { setupLidarProxy } from './lidar-proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const app = express();

// Parse JSON bodies
app.use(express.json({ limit: '5mb' }));

// API routes
app.use('/api', boardApi);

// Static files from repo root
app.use(express.static(ROOT));

// Default to index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

// Parse port from args or env
const port = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || process.env.PORT || '3000', 10);

// Create HTTP server and WebSocket server
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// Setup LiDAR UDP→WebSocket proxy
const lidar = setupLidarProxy(httpServer, wss);

// LiDAR stats API
app.get('/api/lidar/stats', (req, res) => {
  res.json(lidar.getStats());
});

httpServer.listen(port, () => {
  console.log(`\n  KETI TSN Solver + Board Bridge`);
  console.log(`  ──────────────────────────────`);
  console.log(`  Local:   http://localhost:${port}`);
  console.log(`  Solver:  http://localhost:${port}/solver.html`);
  console.log(`  Board:   http://localhost:${port}/board.html`);
  console.log(`  Dash:    http://localhost:${port}/dashboard.html`);
  console.log(`  LiDAR:   http://localhost:${port}/lidar.html`);
  console.log(`  API:     http://localhost:${port}/api/board/status\n`);
});
