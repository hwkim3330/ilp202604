# KETI TSN Platform

Real-time LiDAR traffic analysis + IEEE 802.1Qbv TAS configuration for Microchip LAN9662

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

## Overview

LiDAR 센서 트래픽을 **실시간 분석**하여 TSN 스위치의 TAS(Time-Aware Shaper) 설정을 **자동 생성**하고 적용하는 웹 플랫폼입니다.

**핵심 흐름**: LiDAR 패킷 수신 → 주기/지터 실측(µs) → TAS 사이클 자동 도출 → 보드 push

## Quick Start

```bash
git clone --recursive https://github.com/hwkim3330/ilp202604.git
cd ilp202604
bash run.sh          # → http://localhost:3000
bash setup-board.sh  # Board: no-sec + save + reboot (after USB connect)
```

## How It Works — Real-Time Measurement

### 측정 방법

| 단계 | 기술 | 설명 |
|------|------|------|
| **패킷 수신** | `dgram` (Node.js UDP) | LiDAR UDP 패킷을 직접 수신 (port 7502) |
| **타임스탬프** | `process.hrtime.bigint()` | **나노초 정밀도** 커널 모노토닉 시계 (NTP 영향 없음) |
| **프로파일링** | 슬라이딩 윈도우 | 패킷 500개 + 프레임 100개 (≈10초) 버퍼 |
| **통계 계산** | 순수 JS | 평균, σ(표준편차), min/max, P50/P95/P99 |
| **TAS 도출** | 실측 기반 | cycle = 패킷 간격, TC7 = wire time × margin |
| **스트리밍** | WebSocket | 1초마다 브라우저에 프로파일 + auto-TAS 전송 |
| **시각화** | Canvas 2D | 프레임 주기 바 차트, 지터 분포 히스토그램 |
| **3D 클라우드** | Three.js | LiDAR 포인트클라우드 실시간 렌더링 |
| **보드 제어** | keti-tsn-cli (CoAP) | iPATCH로 TAS 설정 push (196ms, Ethernet) |

### 측정 파이프라인

```
Ouster OS-1-16                    Node.js Server                     Browser
─────────────                    ──────────────                     ───────
UDP 3,392 B ──────────────────▶  dgram.createSocket()
  × 32 pkts/frame                  │
  × 10 fps                        process.hrtime.bigint()
  3,125 µs interval                  │ ← 나노초 타임스탬프
                                   pktTimestamps[] (500개 버퍼)
                                   frameTimestamps[] (100개 버퍼)
                                     │
                                   getTrafficProfile()
                                     ├── fps, frameIntervalUs
                                     ├── pktIntervalUs, jitterUs (σ)
                                     └── bandwidthMbps
                                     │
                                   generateTasConfig()
                                     ├── cycleUs = pktInterval (locked ±10µs)
                                     ├── TC7 slot = wireTime × margin
                                     └── entries[]
                                     │
                                   WebSocket ──────────────────────▶  Canvas 2D
                                   /ws/lidar-timing-a                ├── Frame period chart
                                   (1초마다 profile + autoTas)       └── Jitter histogram
                                     │
                                   WebSocket ──────────────────────▶  Three.js
                                   /ws/lidar-a                       └── 3D point cloud
                                   (Float32Array per frame)
```

### 실측 결과 (Ouster OS-1-16, 2026-04-10)

| Metric | Value | Unit |
|--------|-------|------|
| Packet size | 3,392 | bytes |
| Packets/frame | 32 | |
| Frame rate | 10 | Hz |
| Frame period | 100,000 | µs |
| Packet interval | 3,125 | µs |
| Frame jitter (σ) | ~200 | µs |
| Bandwidth | 8.68 | Mbps |
| Wire time | 27.44 | µs |
| TAS cycle | 3,125 | µs |
| TC7 slot (2× margin) | 54.9 | µs |
| TC7 utilization | 1.76 | % |
| Board push time | ~190 | ms |

## Pages

| Page | URL | Description |
|------|-----|-------------|
| **Home** | `/` | 랜딩 — 보드/LiDAR 상태, 페이지 네비게이션 |
| **LiDAR Live** | `/lidar-live.html` | **메인** — 3D 클라우드 + 타이밍 + GCL 에디터 + 보드 push |
| **Timing** | `/lidar-timing.html` | LiDAR 패킷 타이밍 분석 + GCL 커스텀 에디터 |
| **Detection** | `/lidar-app.html` | 물체 감지 + 안전구역 모니터링 |
| **Dashboard** | `/dashboard.html` | 통합 — 3D 토폴로지 + 솔버 + LiDAR + 멀티보드 |
| **Solver** | `/solver.html` | Greedy/ILP GCL 스케줄러 |
| **Board** | `/board.html` | TAS 설정 읽기/편집 + Quick Profiles |
| **Cloud** | `/lidar.html` | Raw 3D 포인트 클라우드 |
| **How It Works** | `/how-it-works.html` | 파이프라인 설명 + 실측 데이터 + 캡처 |

## Architecture

```
PC (192.168.1.20)          LAN9662 Switch (192.168.1.10)          LiDAR (169.254.195.68)
─────────────────          ──────────────────────────          ─────────────────────
  Node.js :3000              Port 1 ←── Ethernet ──→ Port 2
  ├── Express                  │                        │
  ├── UDP :7502 (dgram)        │  TAS (802.1Qbv)       │  Ouster OS-1-16
  ├── WS /ws/lidar-a           │  Cycle: 3,125 µs      │  UDP 3,392 B × 32 × 10fps
  ├── WS /ws/lidar-timing-a    │  TC7: 54.9 µs         │  8.68 Mbps
  └── CoAP iPATCH (keti-tsn)   │  CoAP :5683           │
                               │  Serial /dev/ttyACM0   │
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/config` | Board + LiDAR config |
| GET | `/api/boards/status` | All boards status (eth→serial fallback) |
| GET | `/api/board/:id/status` | Per-board connectivity |
| GET | `/api/board/:id/gcl` | Read TAS from board (eth→serial fallback) |
| GET | `/api/board/:id/last-pushed` | Last pushed TAS config (no board read) |
| POST | `/api/board/:id/reboot` | Reboot board |
| POST | `/api/gcl/push-port` | Push TAS to port (eth→serial fallback) |
| GET | `/api/lidar/profile/:id` | Real-time traffic profile (µs) |
| GET | `/api/lidar/auto-tas/:id` | Auto-derived TAS config |
| GET | `/api/tas/presets` | TAS preset configurations |
| POST | `/api/lidar/benchmark/:id` | End-to-end pipeline timing |
| POST | `/api/lidar/capture/:id` | Save timing snapshot → `data/` |
| POST | `/api/lidar/compare/:id` | TAS ON/OFF jitter comparison |
| WS | `/ws/lidar-a` | Point cloud (Float32Array) |
| WS | `/ws/lidar-timing-a` | Packet timing + profile stream |

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Timing** | `process.hrtime.bigint()` | 나노초 패킷 타임스탬프 |
| **UDP** | `dgram` (Node.js built-in) | LiDAR 패킷 수신 |
| **Server** | Express 4 | REST API + static files |
| **WebSocket** | `ws` 8 | 실시간 스트리밍 (cloud + timing) |
| **3D** | Three.js 0.167 | LiDAR 포인트클라우드 렌더링 |
| **Charts** | Canvas 2D (vanilla) | 프레임 주기, 지터 분포 (라이브러리 없음) |
| **Solver** | GLPK.js (WASM) | ILP GCL 최적화 |
| **Gantt** | D3.js | GCL 스케줄 시각화 |
| **Board CLI** | [keti-tsn-cli](https://github.com/hrkim-KETI/keti-tsn-cli) | CoAP/CBOR, YANG/SID, MUP1 |
| **Protocol** | IEEE 802.1Qbv | TAS (Time-Aware Shaper) |
| **Board Comm** | CoAP iPATCH | YANG instance → CBOR → Ethernet/Serial |

**No Python, no external charting library** — 타이밍 측정 + 시각화 전부 Node.js + vanilla Canvas 2D.

## Project Structure

```
ilp202604/
├── index.html              # Landing page
├── lidar-live.html         # 3D cloud + timing + GCL editor + board push
├── lidar-timing.html       # Timing analysis + GCL custom editor
├── lidar-app.html          # Safety monitor (object detection)
├── dashboard.html          # Unified dashboard
├── solver.html             # GCL solver (Greedy + ILP)
├── board.html              # Board TAS config editor
├── lidar.html              # Raw 3D point cloud
├── how-it-works.html       # Pipeline docs + measured data
├── js/
│   └── ilp-core.js         # ILP/Greedy solver core
├── vendor/
│   ├── d3.min.js, glpk.js, glpk.wasm
├── server/
│   ├── server.js           # Express + WS + APIs + benchmark + compare
│   ├── config.js           # Board IPs + LiDAR ports
│   ├── board-api.js        # Board REST API (eth→serial fallback)
│   ├── gcl-to-yang.js      # GCL → YANG/CBOR converter
│   └── lidar-proxy.js      # UDP→WS + profiling + auto TAS
├── data/
│   ├── README.md           # Capture format docs
│   ├── lidar-capture-*.json  # Timing snapshots
│   ├── benchmark-*.json    # Pipeline timing results
│   └── compare-*.json      # TAS ON/OFF comparison
├── keti-tsn-cli/           # Board CLI (git submodule)
├── setup-board.sh          # One-click board setup
├── setup-board-fast.sh     # Fast no-sec + verify
└── run.sh                  # bash run.sh → :3000
```

## Hardware

| Component | Model | Connection |
|-----------|-------|------------|
| TSN Switch | Microchip LAN9662 | Serial `/dev/ttyACM0` + Ethernet `192.168.1.10` |
| LiDAR | Ouster OS-1-16 Gen1 | UDP `:7502` (link-local `169.254.195.68`) |
| Host NIC | USB Ethernet | `enxc84d44263ba6` → `192.168.1.20/24` |

### Board Notes

- **Boot time**: 하드 리셋 후 YANG 초기화 ~8분, 시리얼 ~2분, 이더넷 ~3분
- **no-sec 필수**: `setup-board.sh` 실행 (no-sec + save-config + reboot)
- **Port names**: `'1'`, `'2'` (not swp0/swp1)
- **Serial fallback**: 이더넷 CoAP 안 될 때 자동으로 시리얼로 전환
