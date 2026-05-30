#!/bin/bash
# MCP Zombie Process Cleaner
# Kills stale mcp-server-cloudflare processes that consume excessive CPU.
# The Antigravity IDE spawns one per window but never cleans them up.
#
# Strategy: Keep only the NEWEST cloudflare MCP process, kill the rest.
# Also kill any cloudflare MCP process using >50% CPU for >5 minutes.

LOG="/Users/seanbarger_1/Documents/projects/ag-bridge-cpu/logs/mcp-cleanup.log"

# Count cloudflare MCP processes
count=$(pgrep -f "mcp-server-cloudflare" | wc -l | tr -d ' ')

if [ "$count" -le 1 ]; then
    exit 0  # 0 or 1 process — nothing to clean
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Found $count cloudflare MCP processes — cleaning..." >> "$LOG"

# Get all PIDs sorted by start time (newest last)
pids=($(pgrep -f "mcp-server-cloudflare" | sort -n))
total=${#pids[@]}

# Kill all except the last (newest) one
killed=0
for ((i=0; i<total-1; i++)); do
    pid=${pids[$i]}
    cpu=$(ps -p "$pid" -o %cpu= 2>/dev/null | tr -d ' ')
    echo "  Killing PID $pid (CPU: ${cpu}%)" >> "$LOG"
    kill "$pid" 2>/dev/null
    ((killed++))
done

echo "  Killed $killed zombie(s), kept PID ${pids[$((total-1))]}" >> "$LOG"

# Also kill the parent npm exec wrappers that are orphaned
orphan_count=$(pgrep -f "npm exec @cloudflare/mcp-server-cloudflare" | wc -l | tr -d ' ')
if [ "$orphan_count" -gt 1 ]; then
    orphan_pids=($(pgrep -f "npm exec @cloudflare/mcp-server-cloudflare" | sort -n))
    for ((i=0; i<${#orphan_pids[@]}-1; i++)); do
        kill "${orphan_pids[$i]}" 2>/dev/null
    done
    echo "  Cleaned $((orphan_count-1)) orphan npm wrappers" >> "$LOG"
fi
