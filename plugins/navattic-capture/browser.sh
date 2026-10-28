#!/bin/bash
# Starts the shared Navattic automation browser and leaves it open.
# Claude Code's jev-browser tools and replay.mjs both attach to it on the CDP port,
# so they work in the same window, tabs and Navattic session.
#
#   ~/navattic-capture/browser.sh            # opens app.navattic.com
#   ~/navattic-capture/browser.sh URL        # opens URL instead
#   ~/navattic-capture/browser.sh --background [URL]   # detached; returns once the port answers
#
# Everything lives under ~/navattic-capture (override with NAVATTIC_HOME).
# Other overrides: JEV_DIR, NAVATTIC_EXT, NAVATTIC_PROFILE, CDP_PORT
set -euo pipefail
# Optional settings from ~/navattic-capture/.env; variables already in the shell win.
ENV_FILE="${NAVATTIC_HOME:-$HOME/navattic-capture}/.env"
if [ -f "$ENV_FILE" ]; then
  eval "$(node -e '
    const before = new Set(Object.keys(process.env));
    process.loadEnvFile(process.argv[1]);
    for (const [k, v] of Object.entries(process.env))
      if (!before.has(k) && /^[A-Za-z_]\w*$/.test(k)) console.log(`export ${k}=${JSON.stringify(v).replace(/[$`]/g, "\\$&")}`);
  ' "$ENV_FILE")"
fi
ROOT="${NAVATTIC_HOME:-$HOME/navattic-capture}"
JEV_DIR="${JEV_DIR:-$ROOT/jev-browser}"
EXT="${NAVATTIC_EXT:-$ROOT/extension}"
PROFILE="${NAVATTIC_PROFILE:-$ROOT/profile}"
PORT="${CDP_PORT:-9222}"

if curl -fs "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "A browser is already listening on port $PORT; nothing to do."
  exit 0
fi
# --background: start it detached (log in $ROOT/browser.log) and return once the debugging port answers.
if [ "${1:-}" = "--background" ]; then
  shift
  nohup "$0" "$@" >"$ROOT/browser.log" 2>&1 &
  for _ in $(seq 30); do
    curl -fs "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && { echo "Browser started on port $PORT"; exit 0; }
    sleep 0.5
  done
  echo "Browser did not start; see $ROOT/browser.log"; exit 1
fi
[ -f "$EXT/manifest.json" ] || { echo "Navattic extension not found at $EXT (run Step 1)"; exit 1; }
CHROME="$(cd "$JEV_DIR" && node -e "console.log(require('playwright-core').chromium.executablePath())")"
[ -x "$CHROME" ] || { echo "Chromium not found at $CHROME (run: cd $JEV_DIR && node dist/cli.js install chromium)"; exit 1; }

URL="${1:-https://app.navattic.com}"
[ $# -gt 0 ] && shift
echo "Starting Chromium on CDP port $PORT with profile $PROFILE"
exec "$CHROME" \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$PORT" \
  --disable-extensions-except="$EXT" \
  --load-extension="$EXT" \
  --no-first-run --no-default-browser-check \
  "$@" "$URL"
