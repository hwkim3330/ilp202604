# KETI TSN Platform

Real-time LiDAR traffic analysis + IEEE 802.1Qbv TAS configuration for Microchip LAN9662

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

## Overview

LiDAR 센서 트래픽을 실시간 분석하여 TSN(Time-Sensitive Networking) 스위치의 TAS(Time-Aware Shaper) 설정을 자동 생성하고 적용하는 웹 플랫폼입니다.

**핵심 흐름**: LiDAR 패킷 수신 → 주기/지터 실측(µs) → TAS 사이클 자동 도출 → 보드 push

### Features

- **LiDAR Timing Analysis** — 패킷 도착 시간을 µs 단위로 실측, 프레임 주기·패킷 간격·지터 분석, TAS 사이클 자동 도출
- **Auto TAS Generation** — 실측 패킷 간격(3,125 µs)을 사이클로, 와이어 타임(27.44 µs) × 마진을 TC7 슬롯으로 자동 계산
- **Multi-Board / Multi-LiDAR** — 보드 3대(SW_REAR/FL/FR) + LiDAR 3대 구조, config.js로 관리
- **Safety Monitor** — LiDAR 포인트클라우드 클러스터링 → 물체 감지 + 안전구역 알림
- **GCL Solver** — 8-TC 센서 모델, Greedy/ILP(GLPK WASM) 스케줄러
- **Board Control** — CoAP/CBOR over Ethernet (or Serial), keti-tsn CLI

## Quick Start

```bash
git clone --recursive https://github.com/hwkim3330/ilp202604.git
cd ilp202604
bash run.sh
# → http://localhost:3000
```

### Board Ethernet Setup (first time, requires serial)

```bash
cd keti-tsn-cli
node bin/keti-tsn.js patch setup/setup-ip-static.yaml    # IP 192.168.1.10
node bin/keti-tsn.js patch setup/no-sec.yaml              # CoAP no-sec
node bin/keti-tsn.js post setup/save-config.yaml          # Flash save
node bin/keti-tsn.js reboot                               # Reboot
sudo ip addr add 192.168.1.20/24 dev enxc84d44263ba6      # Host IP
ping 192.168.1.10                                          # Verify
```

## Pages

| Page | URL | Description |
|------|-----|-------------|
| **Home** | `/` | 랜딩 — 보드/LiDAR 상태, 페이지 네비게이션 |
| **Timing** | `/lidar-timing.html` | LiDAR 패킷 타이밍 분석 + TAS 자동 생성 + push |
| **Detection** | `/lidar-app.html` | 물체 감지 + 안전구역 모니터링 |
| **Dashboard** | `/dashboard.html` | 통합 — 3D 토폴로지 + 솔버 + LiDAR + 멀티보드 |
| **Solver** | `/solver.html` | Greedy/ILP GCL 스케줄러 |
| **Board** | `/board.html` | TAS 설정 읽기/편집 + Quick Profiles |
| **Cloud** | `/lidar.html` | Raw 3D 포인트 클라우드 |
| **How It Works** | `/how-it-works.html` | 파이프라인 설명 + 실측 데이터 + 캡처 |

## Architecture

```
LiDAR (Ouster OS-1-16)            LAN9662 Switch              Server (Node.js)
──────────────────────            ──────────────              ──────────────────
UDP 3,392 B × 32 pkts/frame  ──▶ Port 2                      Port 1 ◀── PC NIC
10 Hz (100,000 µs period)         │                           │
3,125 µs packet interval          │  TAS (802.1Qbv)           lidar-proxy.js
8.68 Mbps                         │  Cycle: 3,130 µs          ├── UDP :7502 → WS /ws/lidar-a
                                  │  TC7: 54.9 µs (1.75%)     ├── Timing WS /ws/lidar-timing-a
                                  │  BE: 3,073.1 µs           └── Traffic profiling (real-time)
                                  │
                                  │  CoAP :5683               board-api.js
                                  │  192.168.1.10             ├── /api/boards/status
                                  │                           ├── /api/board/:id/status|gcl|reboot
                                  └───────────────────────    ├── /api/gcl/push-port
                                                              └── /api/lidar/profile|auto-tas/:id
```

### Timing Flow

```
1. LiDAR sends UDP packets at 3,125 µs intervals (32 pkts × 10 fps)
2. Server measures arrival timestamps (process.hrtime, ns precision)
3. Computes: frame period, packet interval, jitter (σ), bandwidth
4. Derives TAS cycle = packet interval (3,125 → 3,130 µs rounded)
5. Calculates wire time: (3,392 + 38) × 8 / 1,000 Mbps = 27.44 µs
6. TC7 slot = wire time × 2 margin = 54.9 µs (1.75% utilization)
7. Streams profile + auto-TAS via WebSocket (type: 'profile')
8. Browser renders oscilloscope, frame detail, TAS overlay, jitter histogram
9. One-click push to LAN9662 via keti-tsn CLI (CoAP iPATCH)
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/config` | Board + LiDAR config (IPs, ports) |
| GET | `/api/boards/status` | All boards status (parallel probe) |
| GET | `/api/board/:id/status` | Per-board connectivity check |
| GET | `/api/board/:id/gcl` | Read TAS from board (eth→serial fallback) |
| POST | `/api/board/:id/reboot` | Reboot specific board |
| POST | `/api/gcl/push-port` | Push TAS to board port |
| GET | `/api/lidar/stats` | All LiDAR streaming stats |
| GET | `/api/lidar/profile/:id` | Traffic timing profile (µs) |
| GET | `/api/lidar/auto-tas/:id` | Auto-generated TAS config |
| POST | `/api/lidar/capture/:id` | Snapshot timing data → `data/` JSON |
| GET | `/api/lidar/captures` | List saved capture files |
| GET | `/api/lidar/captures/:file` | Retrieve saved capture |
| WS | `/ws/lidar-a` | Point cloud stream (Float32Array) |
| WS | `/ws/lidar-timing-a` | Packet timing + profile stream |

## Project Structure

```
ilp202604/
├── index.html              # Landing page — status + navigation
├── lidar-timing.html       # LiDAR timing analysis + auto TAS
├── lidar-app.html          # Safety monitor (object detection)
├── dashboard.html          # Unified dashboard
├── solver.html             # GCL solver (Greedy + ILP)
├── board.html              # Board TAS config editor
├── lidar.html              # Raw 3D point cloud viewer
├── how-it-works.html       # Pipeline explanation + measured data + captures
├── roii.glb                # 3D vehicle topology model
├── js/
│   └── ilp-core.js         # ILP/Greedy solver core
├── vendor/
│   ├── d3.min.js, glpk.js, glpk.wasm
├── server/
│   ├── server.js           # Express + WS + multi-LiDAR + multi-board
│   ├── config.js           # Board IPs + LiDAR UDP ports
│   ├── board-api.js        # Board REST API (per-board routing)
│   ├── gcl-to-yang.js      # GCL → YANG/CBOR converter
│   └── lidar-proxy.js      # UDP→WS proxy + traffic profiling + auto TAS
├── data/
│   ├── README.md           # Capture format + measured values documentation
│   └── lidar-capture-*.json  # Saved timing snapshots (real measurements)
├── keti-tsn-cli/           # Board CLI tool (git submodule)
│   ├── bin/keti-tsn.js     # CLI entry point
│   ├── setup/              # YAML configs (IP, no-sec, save, reboot)
│   └── tsc2cbor/           # YANG/SID/CBOR encoder/decoder
└── run.sh                  # bash run.sh → http://localhost:3000
```

## Hardware

| Component | Model | Connection | Details |
|-----------|-------|------------|---------|
| TSN Switch | Microchip LAN9662 | Serial `/dev/ttyACM0` + Ethernet `192.168.1.10` | 2-port, 8-TC TAS, CoAP/CORECONF |
| LiDAR | Ouster OS-1-16 | UDP `:7502` | 16 beams, 512 cols, 3,392 B/pkt, 32 pkts/frame |
| Host NIC | USB Ethernet | `enxc84d44263ba6` | `192.168.1.20/24` |

### Multi-Board Config (3 boards)

Edit `server/config.js`:
```js
export const boards = [
  { id: 'SW_REAR', host: '192.168.1.10' },
  { id: 'SW_FL',   host: '192.168.1.11' },
  { id: 'SW_FR',   host: '192.168.1.12' },
];
export const lidars = [
  { id: 'lidar-a', udpPort: 7502, wsPath: '/ws/lidar-a' },
  { id: 'lidar-b', udpPort: 7512, wsPath: '/ws/lidar-b' },
  { id: 'lidar-c', udpPort: 7522, wsPath: '/ws/lidar-c' },
];
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Three.js (3D), D3.js (Gantt), GLPK WASM (ILP), Canvas 2D (timing) |
| Backend | Node.js, Express, WebSocket (ws), dgram (UDP) |
| Board CLI | [keti-tsn-cli](https://github.com/hrkim-KETI/keti-tsn-cli) — YANG/SID/CBOR, CoAP, MUP1 |
| Protocol | IEEE 802.1Qbv (TAS), CoAP/CORECONF, CBOR |
