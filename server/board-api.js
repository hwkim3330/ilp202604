/**
 * board-api.js — Express routes for LAN9662 board communication
 *
 * Uses keti-tsn CLI (child_process) instead of direct serial access.
 * Direct serial access from Node freezes the board.
 *
 * Routes:
 *   GET  /api/board/status   — Check if board serial device exists
 *   POST /api/gcl/push       — Write YAML temp file → keti-tsn patch → board
 *   POST /api/gcl/export     — Convert GCL → YANG YAML download
 *   GET  /api/gcl/read       — keti-tsn get → parse TAS section
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { boardConfigsToYaml, getConfigSummary, gclToYang } from './gcl-to-yang.js';
import yaml from 'js-yaml';
import { boards } from './config.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// keti-tsn CLI path
const KETI_TSN = path.resolve(__dirname, '../keti-tsn-cli/bin/keti-tsn.js');

const router = express.Router();

/**
 * Resolve board host from boardId or query params
 */
function resolveBoard(req) {
  const boardId = req.params.boardId;
  if (boardId) {
    const board = boards.find(b => b.id === boardId);
    if (board) return { transport: 'eth', host: board.host };
  }
  // Fallback to query params
  const transport = req.query.transport || req.body?.transport || 'serial';
  const host = req.query.host || req.body?.host || null;
  const device = req.query.device || req.body?.device || '/dev/ttyACM0';
  return { transport, host, device };
}

/**
 * Run keti-tsn CLI command
 * @param {string[]} args - CLI arguments
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<{stdout, stderr}>}
 */
async function ketiTsn(args, timeout = 30000) {
  return execFileAsync('node', [KETI_TSN, ...args], {
    cwd: path.resolve(__dirname, '../keti-tsn-cli'),
    timeout,
    maxBuffer: 1024 * 1024
  });
}

/* ── GET /api/board/status ── (backward compat, eth → serial fallback) */
router.get('/board/status', async (req, res) => {
  const device = req.query.device || '/dev/ttyACM0';
  const host = req.query.host || boards[0]?.host;

  // Try ethernet if host available
  if (host) {
    try {
      const { stdout } = await ketiTsn(['checksum', '--transport', 'eth', '--host', host], 5000);
      const connected = stdout.includes('checksum') || stdout.includes('Checksum') || !stdout.includes('Error');
      if (connected) return res.json({ connected: true, transport: 'eth', host });
    } catch {}
  }
  // Fallback to serial
  if (fs.existsSync(device)) {
    try {
      const { stdout } = await ketiTsn(['checksum', '--transport', 'serial', '--port', device], 5000);
      const connected = stdout.includes('checksum') || stdout.includes('Checksum') || !stdout.includes('Error');
      if (connected) return res.json({ connected: true, transport: 'serial', device });
    } catch {}
  }
  res.json({ connected: false, transport: 'none' });
});

/* ── GET /api/board/:boardId/status ── Per-board status (eth → serial fallback) */
router.get('/board/:boardId/status', async (req, res) => {
  const board = boards.find(b => b.id === req.params.boardId);
  if (!board) return res.status(404).json({ error: `Board not found: ${req.params.boardId}` });

  // Try ethernet
  try {
    const { stdout } = await ketiTsn(['checksum', '--transport', 'eth', '--host', board.host], 5000);
    const connected = stdout.includes('checksum') || stdout.includes('Checksum') || !stdout.includes('Error');
    if (connected) return res.json({ id: board.id, connected: true, transport: 'eth', host: board.host, label: board.label });
  } catch {}
  // Fallback to serial (first board only)
  if (board.id === boards[0]?.id && fs.existsSync('/dev/ttyACM0')) {
    try {
      const { stdout } = await ketiTsn(['checksum', '--transport', 'serial', '--port', '/dev/ttyACM0'], 5000);
      const connected = stdout.includes('checksum') || stdout.includes('Checksum') || !stdout.includes('Error');
      if (connected) return res.json({ id: board.id, connected: true, transport: 'serial', host: board.host, label: board.label });
    } catch {}
  }
  res.json({ id: board.id, connected: false, host: board.host, label: board.label });
});

/* ── GET /api/boards/status ── All boards status (eth → serial fallback) */
router.get('/boards/status', async (req, res) => {
  const results = await Promise.all(boards.map(async (board) => {
    // Try ethernet first
    try {
      const args = ['checksum', '--transport', 'eth', '--host', board.host];
      const { stdout } = await ketiTsn(args, 5000);
      const connected = stdout.includes('checksum') || stdout.includes('Checksum') || !stdout.includes('Error');
      if (connected) return { id: board.id, connected: true, host: board.host, label: board.label, transport: 'eth' };
    } catch {}
    // Fallback to serial (only for first board)
    if (board.id === boards[0]?.id && fs.existsSync('/dev/ttyACM0')) {
      try {
        const args = ['checksum', '--transport', 'serial', '--port', '/dev/ttyACM0'];
        const { stdout } = await ketiTsn(args, 5000);
        const connected = stdout.includes('checksum') || stdout.includes('Checksum') || !stdout.includes('Error');
        if (connected) return { id: board.id, connected: true, host: board.host, label: board.label, transport: 'serial' };
      } catch {}
    }
    return { id: board.id, connected: false, host: board.host, label: board.label };
  }));
  res.json(results);
});

/* ── GET /api/board/:boardId/gcl ── Read TAS from specific board */
router.get('/board/:boardId/gcl', async (req, res) => {
  const board = boards.find(b => b.id === req.params.boardId);
  if (!board) return res.status(404).json({ error: `Board not found: ${req.params.boardId}` });

  try {
    // Try ethernet first, fall back to serial if eth fails
    let stdout;
    try {
      const ethResult = await ketiTsn(['get', '--transport', 'eth', '--host', board.host], 30000);
      stdout = ethResult.stdout;
    } catch {
      // Fallback to serial
      const serialResult = await ketiTsn(['get', '--transport', 'serial', '-d', '/dev/ttyACM0'], 90000);
      stdout = serialResult.stdout;
    }

    const configStart = stdout.indexOf('--- Configuration ---');
    const configYaml = configStart >= 0 ? stdout.substring(configStart + 22) : stdout;
    const parsed = yaml.load(configYaml);
    const interfaces = parsed?.['ietf-interfaces:interfaces']?.interface || [];
    const ports = {};

    for (const iface of interfaces) {
      const portName = String(iface.name);
      const bp = iface['ieee802-dot1q-bridge:bridge-port'];
      const gpt = bp?.['ieee802-dot1q-sched-bridge:gate-parameter-table'];
      if (!gpt) continue;

      const mapEntries = (list) => (list?.['gate-control-entry'] || []).map(e => ({
        index: e.index,
        gateStates: e['gate-states-value'],
        timeInterval: e['time-interval-value']
      }));

      const ethInfo = iface['ieee802-ethernet-interface:ethernet'];
      const stats = iface.statistics || {};

      ports[portName] = {
        gateEnabled: gpt['gate-enabled'] ?? false,
        configPending: gpt['config-pending'] ?? false,
        adminCycleTime: gpt['admin-cycle-time'],
        operCycleTime: gpt['oper-cycle-time'],
        adminEntries: mapEntries(gpt['admin-control-list']),
        operEntries: mapEntries(gpt['oper-control-list']),
        supportedListMax: gpt['supported-list-max'],
        operStatus: iface['oper-status'],
        macAddress: iface['phys-address'],
        speed: ethInfo?.speed,
        rxOctets: stats['in-octets'],
        txOctets: stats['out-octets']
      };
    }

    res.json({ id: board.id, host: board.host, ports });
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message });
  }
});

/* ── POST /api/board/:boardId/reboot ── Reboot specific board */
router.post('/board/:boardId/reboot', async (req, res) => {
  const board = boards.find(b => b.id === req.params.boardId);
  if (!board) return res.status(404).json({ error: `Board not found: ${req.params.boardId}` });

  try {
    const args = ['reboot', '--transport', 'eth', '--host', board.host];
    const { stdout, stderr } = await ketiTsn(args);
    res.json({ id: board.id, success: true, output: (stdout + stderr).trim() });
  } catch (e) {
    res.status(500).json({ id: board.id, success: false, error: e.stderr || e.message });
  }
});

/* ── POST /api/gcl/export ── */
router.post('/gcl/export', (req, res) => {
  const { boardConfigs, portMap } = req.body;

  if (!boardConfigs || !portMap) {
    return res.status(400).json({ error: 'boardConfigs and portMap are required' });
  }

  try {
    const yamlStr = boardConfigsToYaml(boardConfigs, portMap);
    res.setHeader('Content-Type', 'text/yaml');
    res.setHeader('Content-Disposition', 'attachment; filename="tas-config.yaml"');
    res.send(yamlStr);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ── POST /api/gcl/push ── */
router.post('/gcl/push', async (req, res) => {
  const {
    boardConfigs,
    portMap,
    device = '/dev/ttyACM0',
    transport = 'serial',
    host = null
  } = req.body;

  if (!boardConfigs || !portMap) {
    return res.status(400).json({ error: 'boardConfigs and portMap are required' });
  }

  // Only check device file for serial transport
  if (transport === 'serial' && !fs.existsSync(device)) {
    return res.status(400).json({ error: `Device not found: ${device}` });
  }
  if ((transport === 'eth' || transport === 'wifi') && !host) {
    return res.status(400).json({ error: `host is required for ${transport} transport` });
  }

  const results = [];
  const summary = getConfigSummary(boardConfigs, portMap);

  for (const item of summary) {
    const portNum = item.port;
    const linkId = item.link;

    try {
      // Find port config
      let portCfg = null;
      let cycleUs = 500;
      for (const [swId, swCfg] of Object.entries(boardConfigs)) {
        if (swCfg.ports[linkId]) {
          portCfg = swCfg.ports[linkId];
          cycleUs = swCfg.cycle_time_us;
          break;
        }
      }

      if (!portCfg) {
        results.push({ port: portNum, link: linkId, success: false, error: 'Port config not found' });
        continue;
      }

      // Convert to YANG YAML
      const yangItems = gclToYang(portNum, portCfg.entries, cycleUs);
      const yamlStr = yaml.dump(yangItems, { lineWidth: -1, quotingType: "'", forceQuotes: false });

      // Write to temp file
      const tmpFile = path.join(os.tmpdir(), `tas-port${portNum}-${Date.now()}.yaml`);
      fs.writeFileSync(tmpFile, yamlStr);

      // Build CLI args based on transport
      const args = ['patch', tmpFile];
      if (transport === 'serial') {
        args.push('-d', device, '--transport', 'serial');
      } else {
        args.push('--transport', transport, '--host', host);
      }
      const { stdout, stderr } = await ketiTsn(args);

      // Clean up temp file
      fs.unlinkSync(tmpFile);

      // Check output for success indicators
      const output = stdout + stderr;
      const success = output.includes('Success') || output.includes('2.04') || output.includes('success') || !output.includes('Error');

      results.push({
        port: portNum,
        link: linkId,
        success,
        entries: item.entries,
        output: output.trim()
      });
    } catch (err) {
      results.push({
        port: portNum,
        link: linkId,
        success: false,
        error: err.stderr || err.message
      });
    }
  }

  res.json({
    results,
    summary: {
      total: results.length,
      success: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length
    }
  });
});

/* ── GET /api/gcl/read ── */
router.get('/gcl/read', async (req, res) => {
  const device = req.query.device || '/dev/ttyACM0';
  const transport = req.query.transport || 'serial';
  const host = req.query.host || null;

  if (transport === 'serial' && !fs.existsSync(device)) {
    return res.status(400).json({ error: `Device not found: ${device}` });
  }
  if ((transport === 'eth' || transport === 'wifi') && !host) {
    return res.status(400).json({ error: `host is required for ${transport} transport` });
  }

  try {
    const args = transport === 'serial'
      ? ['get', '-d', device, '--transport', 'serial']
      : ['get', '--transport', transport, '--host', host];
    const { stdout } = await ketiTsn(args, 90000);

    // Strip "--- Configuration ---" header if present
    const configStart = stdout.indexOf('--- Configuration ---');
    const configYaml = configStart >= 0 ? stdout.substring(configStart + 22) : stdout;

    // Parse full YAML with js-yaml
    const parsed = yaml.load(configYaml);
    const interfaces = parsed?.['ietf-interfaces:interfaces']?.interface || [];
    const ports = {};

    for (const iface of interfaces) {
      const portName = String(iface.name);
      const bp = iface['ieee802-dot1q-bridge:bridge-port'];
      const gpt = bp?.['ieee802-dot1q-sched-bridge:gate-parameter-table'];
      if (!gpt) continue;

      const mapEntries = (list) => (list?.['gate-control-entry'] || []).map(e => ({
        index: e.index,
        gateStates: e['gate-states-value'],
        timeInterval: e['time-interval-value']
      }));

      // Network stats
      const ethInfo = iface['ieee802-ethernet-interface:ethernet'];
      const stats = iface.statistics || {};

      ports[portName] = {
        gateEnabled: gpt['gate-enabled'] ?? false,
        configPending: gpt['config-pending'] ?? false,
        adminCycleTime: gpt['admin-cycle-time'],
        operCycleTime: gpt['oper-cycle-time'],
        adminBaseTime: gpt['admin-base-time'],
        operBaseTime: gpt['oper-base-time'],
        adminEntries: mapEntries(gpt['admin-control-list']),
        operEntries: mapEntries(gpt['oper-control-list']),
        operGateStates: gpt['oper-gate-states'],
        supportedListMax: gpt['supported-list-max'],
        tickGranularity: gpt['tick-granularity'],
        configChangeTime: gpt['config-change-time'],
        currentTime: gpt['current-time'],
        operStatus: iface['oper-status'],
        macAddress: iface['phys-address'],
        speed: ethInfo?.speed,
        rxOctets: stats['in-octets'],
        txOctets: stats['out-octets']
      };
    }

    res.json({ ports });
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message });
  }
});

/* ── POST /api/gcl/push-port ── Direct per-port TAS push */
router.post('/gcl/push-port', async (req, res) => {
  const {
    port,
    cycleUs = 500,
    entries = [],
    device = '/dev/ttyACM0',
    transport = 'serial',
    host = null
  } = req.body;

  if (!port || !entries.length) {
    return res.status(400).json({ error: 'port and entries are required' });
  }
  if (transport === 'serial' && !fs.existsSync(device)) {
    return res.status(400).json({ error: `Device not found: ${device}` });
  }
  if ((transport === 'eth' || transport === 'wifi') && !host) {
    return res.status(400).json({ error: `host is required for ${transport} transport` });
  }

  try {
    // Convert to solver entry format for gclToYang
    const solverEntries = entries.map(e => ({
      gate_mask: e.gateStates.toString(2).padStart(8, '0'),
      duration_us: e.durationUs
    }));

    const yangItems = gclToYang(String(port), solverEntries, cycleUs);
    const yamlStr = yaml.dump(yangItems, { lineWidth: -1, quotingType: "'", forceQuotes: false });

    const tmpFile = path.join(os.tmpdir(), `tas-port${port}-${Date.now()}.yaml`);
    fs.writeFileSync(tmpFile, yamlStr);

    let args = transport === 'serial'
      ? ['patch', tmpFile, '-d', device, '--transport', 'serial']
      : ['patch', tmpFile, '--transport', transport, '--host', host];

    let stdout, stderr;
    try {
      ({ stdout, stderr } = await ketiTsn(args));
    } catch (ethErr) {
      // Fallback to serial if eth fails
      if (transport !== 'serial' && fs.existsSync(device)) {
        args = ['patch', tmpFile, '-d', device, '--transport', 'serial'];
        ({ stdout, stderr } = await ketiTsn(args));
      } else {
        throw ethErr;
      }
    }
    fs.unlinkSync(tmpFile);

    const output = stdout + stderr;
    const success = output.includes('Success') || output.includes('2.04') || output.includes('success') || !output.includes('Error');

    res.json({ port, success, entries: entries.length, output: output.trim() });
  } catch (err) {
    res.status(500).json({ error: err.stderr || err.message });
  }
});

export default router;
