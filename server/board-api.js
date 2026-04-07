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

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// keti-tsn CLI path
const KETI_TSN = path.resolve(__dirname, '../keti-tsn-cli/bin/keti-tsn.js');

const router = express.Router();

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

/* ── GET /api/board/status ── */
router.get('/board/status', (req, res) => {
  const device = req.query.device || '/dev/ttyACM0';
  const connected = fs.existsSync(device);
  res.json({ connected, device });
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
    transport = 'serial'
  } = req.body;

  if (!boardConfigs || !portMap) {
    return res.status(400).json({ error: 'boardConfigs and portMap are required' });
  }

  if (!fs.existsSync(device)) {
    return res.status(400).json({ error: `Device not found: ${device}` });
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

      // Run: keti-tsn patch <file> -d <device> --transport <type>
      const args = ['patch', tmpFile, '-d', device, '--transport', transport];
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

  if (!fs.existsSync(device)) {
    return res.status(400).json({ error: `Device not found: ${device}` });
  }

  try {
    const args = ['get', '-d', device, '--transport', transport];
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
    transport = 'serial'
  } = req.body;

  if (!port || !entries.length) {
    return res.status(400).json({ error: 'port and entries are required' });
  }
  if (!fs.existsSync(device)) {
    return res.status(400).json({ error: `Device not found: ${device}` });
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

    const args = ['patch', tmpFile, '-d', device, '--transport', transport];
    const { stdout, stderr } = await ketiTsn(args);
    fs.unlinkSync(tmpFile);

    const output = stdout + stderr;
    const success = output.includes('Success') || output.includes('2.04') || output.includes('success') || !output.includes('Error');

    res.json({ port, success, entries: entries.length, output: output.trim() });
  } catch (err) {
    res.status(500).json({ error: err.stderr || err.message });
  }
});

export default router;
