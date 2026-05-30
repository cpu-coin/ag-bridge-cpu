#!/bin/bash
# bridge-launcher.sh — Wrapper for launchd that adds startup resilience.
#
# Why a wrapper?
# launchd kills processes immediately if they crash too fast (exit 78 throttle).
# This script adds a small startup delay after reboot, ensures the port is free,
# and exec's into node so launchd can manage the real process directly.

LOG_DIR="$(dirname "$0")/../logs"
STDOUT_LOG="${LOG_DIR}/bridge-stdout.log"
STDERR_LOG="${LOG_DIR}/bridge-stderr.log"

# Rotate logs if they're over 5MB
for f in "$STDOUT_LOG" "$STDERR_LOG"; do
    if [ -f "$f" ] && [ "$(stat -f%z "$f" 2>/dev/null || echo 0)" -gt 5242880 ]; then
        mv "$f" "${f}.old"
    fi
done

echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] [LAUNCHER] Starting bridge-launcher.sh (PID $$)" >> "$STDOUT_LOG"

# Wait for network to be ready (important after reboot)
RETRIES=0
MAX_RETRIES=30
while ! /sbin/ping -c1 -t1 1.1.1.1 >/dev/null 2>&1; do
    RETRIES=$((RETRIES + 1))
    if [ $RETRIES -ge $MAX_RETRIES ]; then
        echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] [LAUNCHER] Network not available after ${MAX_RETRIES}s — starting anyway" >> "$STDOUT_LOG"
        break
    fi
    sleep 1
done

if [ $RETRIES -gt 0 ] && [ $RETRIES -lt $MAX_RETRIES ]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] [LAUNCHER] Network ready after ${RETRIES}s" >> "$STDOUT_LOG"
fi

# Kill any stale process on port 8787
STALE_PID=$(/usr/sbin/lsof -ti :8787 2>/dev/null)
if [ -n "$STALE_PID" ]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] [LAUNCHER] Killing stale PID(s) on port 8787: $STALE_PID" >> "$STDOUT_LOG"
    echo "$STALE_PID" | xargs kill -9 2>/dev/null
    sleep 2
fi

# exec replaces this shell with node — launchd tracks the node PID directly
exec /Users/seanbarger_1/.nvm/versions/node/v22.21.1/bin/node \
    /Users/seanbarger_1/Documents/projects/ag-bridge-cpu/server.mjs
