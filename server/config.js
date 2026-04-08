/**
 * config.js — Multi-board + Multi-LiDAR configuration
 *
 * Topology: PC → Board-A P1, Board-A P2 → Board-B P1, Board-B P2 → Board-C P1
 * Each board has one LiDAR attached (via the other port or same segment).
 *
 * LiDAR UDP ports must be configured per-sensor (Ouster web UI: udp_dest + udp_port_lidar).
 */

export const boards = [
  { id: 'SW_REAR', host: '192.168.1.10', label: 'SW_REAR (Board-A)' },
  { id: 'SW_FL',   host: '192.168.1.11', label: 'SW_FL (Board-B)' },
  { id: 'SW_FR',   host: '192.168.1.12', label: 'SW_FR (Board-C)' },
];

export const lidars = [
  { id: 'lidar-a', udpPort: 7502, wsPath: '/ws/lidar-a', label: 'Ouster A (REAR)' },
  { id: 'lidar-b', udpPort: 7512, wsPath: '/ws/lidar-b', label: 'Ouster B (FL)' },
  { id: 'lidar-c', udpPort: 7522, wsPath: '/ws/lidar-c', label: 'Ouster C (FR)' },
];

// Keep backward-compatible: first LiDAR also serves /ws/lidar
export const defaultLidarWsPath = '/ws/lidar';
