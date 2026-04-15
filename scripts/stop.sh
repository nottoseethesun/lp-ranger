#!/usr/bin/env bash
# Gracefully stop the 9mm Position Manager server.
# 1. Try POST /api/shutdown with a 5-second timeout.
# 2. If that fails, find the node server.js process by port and kill it.

set -euo pipefail

PORT="${PORT:-5555}"

echo "Stopping 9mm Position Manager on port $PORT..."

# Fetch a CSRF token, then try graceful shutdown (5s timeout each)
CSRF=$(curl -sf -m 5 "http://127.0.0.1:${PORT}/api/csrf-token" 2>/dev/null \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
if [ -n "$CSRF" ] && curl -sf -m 5 -X POST \
  -H "x-csrf-token: ${CSRF}" \
  "http://127.0.0.1:${PORT}/api/shutdown" >/dev/null 2>&1; then
  echo "✔ Graceful shutdown succeeded"
  exit 0
fi

echo "Graceful shutdown failed — looking for process on port $PORT..."

# Find PIDs listening on the port (exclude browsers etc — only node)
PIDS=$(lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null || true)

if [ -z "$PIDS" ]; then
  echo "No process found listening on port $PORT"
  exit 0
fi

for PID in $PIDS; do
  CMD=$(ps -p "$PID" -o cmd= 2>/dev/null || true)
  if echo "$CMD" | grep -q "node"; then
    kill "$PID" 2>/dev/null && echo "✔ Killed PID $PID ($CMD)" || true
  fi
done

# Wait briefly then verify
sleep 1
REMAINING=$(lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$REMAINING" ]; then
  echo "⚠ Process still running — sending SIGKILL"
  for PID in $REMAINING; do
    kill -9 "$PID" 2>/dev/null || true
  done
fi

echo "✔ Stopped"
