#!/bin/bash
# setup-board-fast.sh — Fast no-sec apply right after boot
# The board temporarily allows CoAP without security during boot.
# We must apply no-sec + save BEFORE the security mode activates (~1-2 min).
set -e
cd "$(dirname "$0")"
CLI="node keti-tsn-cli/bin/keti-tsn.js"
SERIAL="/dev/ttyACM0"
BOARD_IP="192.168.1.10"

echo "━━━ Fast Board Setup ━━━"
echo "Waiting for serial device..."
for i in $(seq 1 30); do [ -e "$SERIAL" ] && break; sleep 1; done
[ -e "$SERIAL" ] || { echo "FAIL: no serial"; exit 1; }
echo "✓ Serial found"

echo "Waiting for CoAP ready (polling every 5s)..."
for i in $(seq 1 60); do
  result=$($CLI checksum --transport serial --port $SERIAL 2>&1 || true)
  if echo "$result" | grep -q "Received checksum"; then
    echo "✓ CoAP ready (attempt $i)"
    break
  fi
  payload=$(echo "$result" | grep -o 'Payload:.*' | head -1)
  echo -ne "\r  ⏳ $i — $payload     "
  sleep 5
done

echo ""
echo "Applying no-sec IMMEDIATELY..."
for attempt in 1 2 3 4 5; do
  result=$($CLI patch keti-tsn-cli/setup/no-sec.yaml --transport serial --port $SERIAL 2>&1 || true)
  if echo "$result" | grep -q "Success: 1"; then
    echo "✓ no-sec applied (attempt $attempt)"
    break
  fi
  echo "  retry $attempt..."
  sleep 2
done

echo "Saving to flash..."
$CLI post keti-tsn-cli/setup/save-config.yaml --transport serial --port $SERIAL 2>&1 || true
echo "✓ save-config"

echo "Verifying save worked (checking eth)..."
sleep 2
eth=$($CLI checksum --transport eth --host $BOARD_IP 2>&1 || true)
if echo "$eth" | grep -q "Received checksum"; then
  echo "✓ Ethernet OK"
else
  echo "⚠ Ethernet not ready yet"
fi

echo ""
echo "Rebooting to verify no-sec persists..."
$CLI reboot --transport serial --port $SERIAL 2>&1 || true
echo "Waiting 25s for reboot..."
sleep 25

echo "Checking serial after reboot..."
for i in $(seq 1 20); do
  result=$($CLI checksum --transport serial --port $SERIAL 2>&1 || true)
  if echo "$result" | grep -q "Received checksum"; then
    echo "✓ Serial OK after reboot"
    break
  fi
  sleep 5
done

echo "Waiting 60s for security mode test..."
sleep 60

echo "Checking if no-sec persisted (this is the real test)..."
result=$($CLI checksum --transport serial --port $SERIAL 2>&1 || true)
if echo "$result" | grep -q "Received checksum"; then
  echo "✓✓✓ no-sec PERSISTED! Board is stable."
else
  echo "✗ no-sec did NOT persist. save-config may not work for security-mode."
  echo "  The board resets to secure mode after full init."
fi

echo ""
echo "Checking ethernet..."
eth=$($CLI checksum --transport eth --host $BOARD_IP 2>&1 || true)
if echo "$eth" | grep -q "Received checksum"; then
  echo "✓ Ethernet works"
else
  echo "✗ Ethernet FAIL"
fi

echo ""
echo "━━━ Done ━━━"
