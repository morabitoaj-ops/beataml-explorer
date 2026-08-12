#!/usr/bin/env bash
# Serve the explorer locally. Usage: ./serve.sh [port]
set -euo pipefail
PORT="${1:-8777}"
cd "$(dirname "$0")/web"
echo "BeatAML2 Explorer -> http://localhost:${PORT}"
exec python3 -m http.server "$PORT"
