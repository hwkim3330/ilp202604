#!/bin/bash
cd "$(dirname "$0")/server"
[ -d node_modules ] || npm install
echo "→ http://localhost:3000"
exec node server.js "$@"
