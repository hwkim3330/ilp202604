# KETI TSN Platform

ILP/Greedy GCL Solver + Microchip LAN9662 Board Integration + LiDAR Point Cloud

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

## Overview

TSN(Time-Sensitive Networking) GCL(Gate Control List) 스케줄링을 Greedy/ILP 알고리즘으로 풀고, 결과를 LAN9662 보드에 직접 적용하는 웹 기반 플랫폼입니다.

### Features

- **GCL Solver** — 8-TC 센서 모델 기반 Greedy/ILP(GLPK WASM) 스케줄러. 3D 토폴로지(Three.js + GLB), per-switch Gantt 타임라인, 지연 분석
- **Board Integration** — 솔버 결과를 YANG/CBOR로 변환하여 LAN9662 보드에 CoAP iPATCH 전송. TAS 설정 실시간 읽기/쓰기
- **LiDAR Visualization** — Ouster OS-1-16 UDP 스트림을 WebSocket으로 브릿지, Three.js 3D 포인트 클라우드 실시간 렌더링

## Quick Start

```bash
git clone --recursive https://github.com/hwkim3330/ilp202604.git
cd ilp202604
bash run.sh
# → http://localhost:3000
```

## Pages

| Page | URL | Description |
|------|-----|-------------|
| Home | `/` | 대시보드, 보드 연결 상태 표시 |
| GCL Solver | `/solver.html` | Greedy/ILP 솔버 + 3D 토폴로지 + Gantt + Board Push |
| Board Config | `/board.html` | LAN9662 TAS 설정 읽기/편집 + Quick Profiles |
| LiDAR | `/lidar.html` | Ouster OS-1 실시간 3D 포인트 클라우드 |

## Architecture

```
Browser                          Server (Node.js/Express)
┌──────────────┐                ┌─────────────────────────┐
│ solver.html  │─── POST ──────│ /api/gcl/push            │
│  GLPK WASM   │   GCL JSON    │  gcl-to-yang.js          │
│  Three.js    │                │    → YANG/YAML           │
│  D3.js       │                │    → keti-tsn CLI patch  │
├──────────────┤                │                          │
│ board.html   │─── GET ───────│ /api/gcl/read            │
│  TAS Editor  │   TAS config  │    → keti-tsn CLI get    │
├──────────────┤                │                          │
│ lidar.html   │◄── WebSocket ─│ lidar-proxy.js           │
│  Three.js    │   XYZ+I bin   │    ← UDP :7502 (Ouster)  │
└──────────────┘                └─────────────────────────┘
                                         │
                                    /dev/ttyACM0
                                         │
                                  ┌──────┴──────┐
                                  │  LAN9662    │
                                  │  (MUP1/CoAP)│
                                  └─────────────┘
```

## Project Structure

```
ilp202604/
├── index.html          # Landing page
├── solver.html         # GCL solver (Greedy + ILP)
├── board.html          # Board config viewer/editor
├── lidar.html          # LiDAR point cloud viewer
├── style.css           # Shared styles
├── roii.glb            # 3D vehicle topology model
├── js/
│   └── ilp-core.js     # ILP/Greedy solver core
├── vendor/
│   ├── d3.min.js       # D3.js
│   ├── glpk.js         # GLPK WASM loader
│   └── glpk.wasm       # GLPK WASM binary
├── server/
│   ├── server.js       # Express + WebSocket server
│   ├── board-api.js    # LAN9662 board API routes
│   ├── gcl-to-yang.js  # GCL → YANG/CBOR converter
│   └── lidar-proxy.js  # Ouster UDP → WebSocket bridge
├── keti-tsn-cli/       # Board CLI tool (git submodule)
└── run.sh              # One-line launcher
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/board/status` | Board connection status |
| GET | `/api/gcl/read` | Read current TAS config from board |
| POST | `/api/gcl/push` | Push GCL to board (YANG/CBOR) |
| POST | `/api/gcl/export` | Export GCL as YANG YAML |
| GET | `/api/lidar/stats` | LiDAR streaming statistics |

## Hardware Setup

- **Board**: Microchip LAN9662 via USB serial (`/dev/ttyACM0`, 115200 baud)
- **LiDAR**: Ouster OS-1-16 (UDP port 7502, LEGACY format)
- **Protocol**: MUP1 (Microchip UART Protocol) + CoAP/CORECONF

## Tech Stack

- **Frontend**: Three.js, D3.js, GLPK WASM, Chart.js
- **Backend**: Node.js, Express, WebSocket
- **Protocols**: CoAP iPATCH, YANG/CBOR, MUP1
- **Standards**: IEEE 802.1Qbv (TAS), IEEE 802.1Qav (CBS)
