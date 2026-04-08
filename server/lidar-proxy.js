/**
 * lidar-proxy.js — UDP → WebSocket bridge for Ouster LiDAR
 *
 * Supports multiple LiDAR instances, each on a different UDP port
 * and WebSocket path. Backward-compatible: /ws/lidar still works.
 *
 * Wire format to browser (per frame, Float32Array):
 *   [x0, y0, z0, intensity0, x1, y1, z1, intensity1, ...]
 */

import dgram from 'dgram';

// Ouster OS-1-16 Gen1 beam intrinsics (from get_beam_intrinsics)
const BEAM_ALTITUDE_DEG = [14.18, 12.06, 9.95, 8.70, 5.80, 3.73, 1.67, -0.40,
                           -2.47, -4.54, -6.61, -8.69, -10.78, -12.89, -15.02, -17.21];
const BEAM_AZIMUTH_DEG  = [-3.30, -3.26, -3.21, -3.16, -3.15, -3.13, -3.11, -3.09,
                           -3.08, -3.07, -3.07, -3.08, -3.07, -3.09, -3.11, -3.15];
const ORIGIN_MM = 12.163;
const PIXELS_PER_COL = 16;
const ENCODER_TICKS = 90112;

const beamAlt = BEAM_ALTITUDE_DEG.map(d => d * Math.PI / 180);
const beamAz  = BEAM_AZIMUTH_DEG.map(d => d * Math.PI / 180);
const cosAlt  = beamAlt.map(Math.cos);
const sinAlt  = beamAlt.map(Math.sin);

/**
 * Parse LEGACY lidar packet (3392 bytes = 16 columns × 212 bytes)
 */
function parsePacket(buf) {
  const COL_SIZE = 212;
  const cols = [];
  for (let c = 0; c < 16; c++) {
    const off = c * COL_SIZE;
    const measId = buf.readUInt16LE(off + 8);
    const frameId = buf.readUInt16LE(off + 10);
    const encoder = buf.readUInt32LE(off + 12);
    const azRad = (encoder / ENCODER_TICKS) * 2 * Math.PI;

    const pixels = [];
    for (let p = 0; p < PIXELS_PER_COL; p++) {
      const poff = off + 16 + p * 12;
      const range = buf.readUInt32LE(poff);
      const refl  = buf.readUInt16LE(poff + 4);
      const signal = buf.readUInt16LE(poff + 6);

      if (range === 0) { pixels.push(null); continue; }

      const r = range / 1000;
      const totalAz = azRad + beamAz[p];
      const x = r * cosAlt[p] * Math.cos(totalAz) + (ORIGIN_MM / 1000) * Math.cos(totalAz);
      const y = r * cosAlt[p] * Math.sin(totalAz) + (ORIGIN_MM / 1000) * Math.sin(totalAz);
      const z = r * sinAlt[p];

      pixels.push({ x, y, z, intensity: refl || signal });
    }
    cols.push({ measId, frameId, encoder, pixels });
  }
  return cols;
}

/**
 * Create a single LiDAR UDP→WS instance
 * @param {object} wss - WebSocketServer
 * @param {string} id - LiDAR identifier
 * @param {number} udpPort - UDP port to listen on
 * @param {string[]} wsPaths - WebSocket paths to serve (e.g. ['/ws/lidar-a', '/ws/lidar'])
 */
function createLidarInstance(wss, id, udpPort, wsPaths) {
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  let currentFrameId = -1;
  let framePoints = [];
  let clients = new Set();
  let stats = { fps: 0, points: 0, lastFrame: 0, frames: 0 };
  let lastStatTime = Date.now();

  // Track WS clients for this instance
  wss.on('connection', (ws, req) => {
    if (wsPaths.includes(req.url)) {
      clients.add(ws);
      ws.send(JSON.stringify({
        type: 'metadata',
        id,
        beams: PIXELS_PER_COL,
        beamAltitude: BEAM_ALTITUDE_DEG,
        beamAzimuth: BEAM_AZIMUTH_DEG,
        originMm: ORIGIN_MM
      }));
      ws.on('close', () => clients.delete(ws));
    }
  });

  function broadcastFrame(points) {
    stats.frames++;
    stats.points = points.length;
    const now = Date.now();
    if (now - lastStatTime >= 1000) {
      stats.fps = stats.frames;
      stats.frames = 0;
      lastStatTime = now;
    }
    if (clients.size === 0) return;
    const buf = new Float32Array(points.length * 4);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      buf[i * 4]     = p.x;
      buf[i * 4 + 1] = p.y;
      buf[i * 4 + 2] = p.z;
      buf[i * 4 + 3] = p.intensity;
    }
    const binary = Buffer.from(buf.buffer);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(binary);
    }
  }

  let pktCount = 0;
  udp.on('message', (msg) => {
    pktCount++;
    if (pktCount <= 3) console.log(`  LiDAR [${id}] pkt #${pktCount}: ${msg.length} bytes`);
    if (msg.length !== 3392) return;
    const cols = parsePacket(msg);
    if (cols.length === 0) return;

    const fid = cols[0].frameId;
    if (fid !== currentFrameId && currentFrameId !== -1) {
      broadcastFrame(framePoints);
      framePoints = [];
    }
    currentFrameId = fid;

    for (const col of cols) {
      for (const px of col.pixels) {
        if (px) framePoints.push(px);
      }
    }
  });

  udp.on('error', (err) => {
    console.error(`  LiDAR [${id}] UDP error:`, err.message);
  });

  udp.bind(udpPort, '0.0.0.0', () => {
    console.log(`  LiDAR [${id}]: UDP :${udpPort} → WebSocket ${wsPaths.join(', ')}`);
  });

  return {
    id,
    getStats: () => ({ ...stats, id, clients: clients.size })
  };
}

/**
 * Setup all LiDAR proxies from config
 * @param {object} server - HTTP server
 * @param {object} wss - WebSocketServer
 * @param {object[]} lidarConfigs - Array of { id, udpPort, wsPath, label }
 * @param {string} [defaultWsPath] - Backward-compat path (e.g. '/ws/lidar')
 */
export function setupLidarProxy(server, wss, lidarConfigs, defaultWsPath) {
  // Single-LiDAR backward compat: if no config array, use legacy defaults
  if (!lidarConfigs) {
    lidarConfigs = [{ id: 'lidar', udpPort: 7502, wsPath: '/ws/lidar' }];
  }

  const instances = lidarConfigs.map((cfg, i) => {
    const wsPaths = [cfg.wsPath];
    // First LiDAR also serves the default path for backward compat
    if (i === 0 && defaultWsPath && defaultWsPath !== cfg.wsPath) {
      wsPaths.push(defaultWsPath);
    }
    return createLidarInstance(wss, cfg.id, cfg.udpPort, wsPaths);
  });

  return {
    instances,
    getStats: () => instances.map(inst => inst.getStats()),
    // Backward compat: single stats for first instance
    getFirstStats: () => instances[0]?.getStats() || { fps: 0, points: 0, frames: 0, clients: 0 }
  };
}
