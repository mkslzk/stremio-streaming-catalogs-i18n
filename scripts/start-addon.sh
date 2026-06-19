#!/usr/bin/env bash
# Start the Stremio Streaming Catalogs i18n addon.
#
# Usage:
#   ./scripts/start-addon.sh           # German (default), port 7700
#   PORT=7707 ./scripts/start-addon.sh
#   CATALOG_LANGUAGE=fr ./scripts/start-addon.sh
#
# Honours env vars: CATALOG_LANGUAGE, PORT
# Picks up TMDB_API_KEY / TMDB_READ_TOKEN from .env (root).
set -euo pipefail

# Resolve project root (parent of this script)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Load .env if present
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
fi

# Defaults
export CATALOG_LANGUAGE="${CATALOG_LANGUAGE:-de}"
export PORT="${PORT:-7700}"

# Resolve LAN IP for the install instructions
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
: "${LAN_IP:=localhost}"

echo "🚀 Starting Stremio Streaming Catalogs — i18n"
echo "   Language:  $CATALOG_LANGUAGE"
echo "   Port:      $PORT"
echo "   LAN IP:    $LAN_IP"
echo ""
echo "Install in Stremio:"
echo "   http://$LAN_IP:$PORT/manifest.json"
echo "   stremio://$LAN_IP:$PORT/manifest.json"
echo ""
echo "(Ctrl+C to stop; the TMDB cache will be saved on shutdown)"
echo ""

exec node index.js