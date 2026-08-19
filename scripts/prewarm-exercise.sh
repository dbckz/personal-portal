#!/bin/bash
# Pre-warm today's AI exercise programme so the Today page opens with the plan
# already generated instead of showing "Refining today's plan…" for minutes.
# GET /api/exercise/targets kicks off background generation on a cache miss and
# is a cheap no-op on a hit, so calling it early each morning (launchd:
# com.davebuckley.portal-exercise-prewarm) is all the warming needed.

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT_FILE="$APP_DIR/.data/current-port"

if [ ! -f "$PORT_FILE" ]; then
    echo "$(date '+%F %T') no port file at $PORT_FILE — portal not running?" >&2
    exit 1
fi
PORT=$(cat "$PORT_FILE")

# The portal may still be coming up after a reboot; a few spaced retries cover it.
for attempt in 1 2 3; do
    if curl -sf --max-time 30 "http://localhost:${PORT}/api/exercise/targets" > /dev/null; then
        echo "$(date '+%F %T') prewarm triggered on port ${PORT}"
        exit 0
    fi
    sleep 20
done

echo "$(date '+%F %T') prewarm failed after 3 attempts on port ${PORT}" >&2
exit 1
