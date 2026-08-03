#!/usr/bin/env bash
# Starts a local HTTP server for the WebDFU tool.
# Usage: ./serve.sh [port]
# Then open http://localhost:<port> in Chrome or Edge.

PORT="${1:-8080}"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Serving WebDFU at http://localhost:${PORT}"
echo "Press Ctrl+C to stop."
python3 -m http.server "$PORT" --directory "$DIR"
