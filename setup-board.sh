#!/bin/bash
# setup-board.sh — One-click board setup after power cycle
# Usage: bash setup-board.sh
#
# Waits for board to become ready, applies no-sec, saves config,
# reboots, then verifies ethernet connectivity.

set -e
cd "$(dirname "$0")"

CLI="node keti-tsn-cli/bin/keti-tsn.js"
SERIAL="/dev/ttyACM0"
BOARD_IP="192.168.1.10"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

step() { echo -e "\n${BLUE}[$1/7]${NC} $2"; }
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
wait_msg() { echo -e "  ${YELLOW}⏳${NC} $1"; }

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  KETI TSN — LAN9662 Board Setup${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Step 1: Wait for serial device
step 1 "Waiting for serial device ${SERIAL}..."
for i in $(seq 1 30); do
  if [ -e "$SERIAL" ]; then
    ok "Serial device found"
    break
  fi
  sleep 1
  if [ $i -eq 30 ]; then
    fail "Serial device not found after 30s"
    exit 1
  fi
done

# Step 2: Wait for board CoAP to be ready (checksum must succeed)
step 2 "Waiting for board CoAP service (this takes ~8 min after hard reset)..."
wait_msg "Polling every 15 seconds..."
for i in $(seq 1 60); do
  result=$($CLI checksum --transport serial --port $SERIAL 2>&1 || true)
  if echo "$result" | grep -q "Received checksum"; then
    ok "Board CoAP ready (attempt $i)"
    break
  fi
  # Show progress
  payload=$(echo "$result" | grep -o 'Payload:.*' | head -1)
  if [ -n "$payload" ]; then
    echo -ne "\r  ⏳ Attempt $i/60 — $payload     "
  fi
  if [ $i -eq 60 ]; then
    echo ""
    fail "Board not ready after 15 minutes"
    exit 1
  fi
  sleep 15
done

# Step 3: Apply no-sec
step 3 "Applying CoAP no-sec mode..."
result=$($CLI patch keti-tsn-cli/setup/no-sec.yaml --transport serial --port $SERIAL 2>&1 || true)
if echo "$result" | grep -q "Success: 1"; then
  ok "no-sec applied"
else
  # Maybe already in no-sec, try anyway
  echo "$result" | tail -3
  wait_msg "Continuing anyway..."
fi

# Step 4: Save config to flash
step 4 "Saving configuration to flash..."
result=$($CLI post keti-tsn-cli/setup/save-config.yaml --transport serial --port $SERIAL 2>&1 || true)
ok "save-config sent"

# Step 5: Reboot
step 5 "Rebooting board..."
result=$($CLI reboot --transport serial --port $SERIAL 2>&1 || true)
if echo "$result" | grep -q "Reboot command sent"; then
  ok "Reboot sent, waiting 20 seconds..."
else
  wait_msg "Reboot may have failed, waiting anyway..."
fi
sleep 20

# Step 6: Wait for board to come back + verify serial
step 6 "Verifying serial connection..."
for i in $(seq 1 20); do
  result=$($CLI checksum --transport serial --port $SERIAL 2>&1 || true)
  if echo "$result" | grep -q "Received checksum"; then
    ok "Serial checksum OK"
    break
  fi
  sleep 10
  if [ $i -eq 20 ]; then
    fail "Board not responding after reboot"
    exit 1
  fi
done

# Step 7: Verify ethernet
step 7 "Verifying ethernet connection (${BOARD_IP})..."
# Make sure IP is set
ip addr show | grep -q "192.168.1.20" || {
  wait_msg "Adding 192.168.1.20 to NIC..."
  sudo ip addr add 192.168.1.20/24 dev enxc84d44263ba6 2>/dev/null || true
}

for i in $(seq 1 10); do
  result=$($CLI checksum --transport eth --host $BOARD_IP 2>&1 || true)
  if echo "$result" | grep -q "Received checksum"; then
    ok "Ethernet checksum OK"
    break
  fi
  sleep 5
  if [ $i -eq 10 ]; then
    fail "Ethernet connection failed"
    echo "  Serial works but ethernet doesn't — check IP config"
    exit 1
  fi
done

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Board setup complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Serial:   $SERIAL ✓"
echo "  Ethernet: $BOARD_IP ✓"
echo "  CoAP:     no-sec ✓"
echo ""
echo "  Ready for TAS push:"
echo "    curl -X POST http://localhost:3000/api/lidar/benchmark/lidar-a \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"boardId\":\"SW_REAR\",\"port\":\"1\",\"transport\":\"eth\"}'"
echo ""
