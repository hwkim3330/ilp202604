/**
 * server.js — Express bridge server
 *
 * Serves static files (solver.html, js/, vendor/) and provides
 * API routes for LAN9662 board communication.
 *
 * Usage: node server.js [--port 3000] [--device /dev/ttyACM0]
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import boardApi from './board-api.js';

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

app.listen(port, () => {
  console.log(`\n  KETI TSN Solver + Board Bridge`);
  console.log(`  ──────────────────────────────`);
  console.log(`  Local:   http://localhost:${port}`);
  console.log(`  Solver:  http://localhost:${port}/solver.html`);
  console.log(`  Board:   http://localhost:${port}/board.html`);
  console.log(`  API:     http://localhost:${port}/api/board/status\n`);
});
