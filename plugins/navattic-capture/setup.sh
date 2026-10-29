#!/bin/bash
# One-time setup for navattic-capture, safe to rerun: each part is skipped when it is already there.
# Code stays where this script is; data goes in ~/navattic-capture (override with NAVATTIC_HOME):
#   jev-browser/  tontoko/jev-browser, built from GitHub (it is not on npm), plus its Chromium
#   extension/    the Navattic extension from the Chrome Web Store, pinned to its store ID
#   opts.json     makes jev-browser attach to the shared browser
#   .env          decision-model and Gemini keys, from .env.example
#
#   bash setup.sh                     # everything
#   bash setup.sh --update-extension  # also replace the extension with the store's current version
set -euo pipefail
CODE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${NAVATTIC_HOME:-$HOME/navattic-capture}"
JEV_TAG=v0.18.0
EXT_ID=lbecioncobbndebbfdopnpinnibemoon
mkdir -p "$ROOT"

node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=15)?0:1)' \
  || { echo "Node.js 22.15 or newer is needed (found $(node --version))"; exit 1; }

[ -f "$ROOT/opts.json" ] || echo '{"cdpEndpoint": "http://127.0.0.1:9222"}' > "$ROOT/opts.json"
if [ ! -f "$ROOT/.env" ]; then
  cp "$CODE/.env.example" "$ROOT/.env" && chmod 600 "$ROOT/.env"
  echo "Created $ROOT/.env: add a decision-model key to it."
fi

if [ ! -f "$ROOT/jev-browser/dist/cli.js" ]; then
  echo "Installing jev-browser $JEV_TAG into $ROOT/jev-browser"
  rm -rf "$ROOT/jev-browser"
  git clone --quiet --depth 1 --branch "$JEV_TAG" https://github.com/tontoko/jev-browser.git "$ROOT/jev-browser"
  (cd "$ROOT/jev-browser" && npm ci --silent && npm run --silent build && node dist/cli.js install chromium)
fi

if [ ! -f "$ROOT/extension/manifest.json" ] || [ "${1:-}" = "--update-extension" ]; then
  if curl -fs http://127.0.0.1:${CDP_PORT:-9222}/json/version >/dev/null 2>&1; then
    echo "Quit the shared browser before replacing the extension."; exit 1
  fi
  echo "Downloading the Navattic extension into $ROOT/extension"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/navattic.crx" "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=140.0&acceptformat=crx2,crx3&x=id%3D$EXT_ID%26uc"
  # A CRX is a zip behind a signed header; unzip warns about the header and exits 1.
  unzip -oq "$tmp/navattic.crx" -d "$tmp/extension" 2>/dev/null || [ -f "$tmp/extension/manifest.json" ]
  # Copy the store's public key into manifest.json, so Chromium gives this unpacked copy the store ID
  # (the Navattic web app talks to the extension by that ID).
  python3 -I - "$tmp" "$EXT_ID" <<'EOF'
import json, hashlib, base64, os, sys
tmp, want = sys.argv[1], sys.argv[2]
d = open(os.path.join(tmp, 'navattic.crx'), 'rb').read()
sig = bytes.fromhex('30820122300d06092a864886f70d01010105000382010f00')
pos = 0
while True:
    i = d.find(sig, pos)
    if i < 0: sys.exit('store key not found in the CRX')
    spki = d[i:i+294]
    if ''.join(chr(97 + int(c, 16)) for c in hashlib.sha256(spki).hexdigest()[:32]) == want: break
    pos = i + 1
p = os.path.join(tmp, 'extension', 'manifest.json')
m = json.load(open(p)); m['key'] = base64.b64encode(spki).decode()
json.dump(m, open(p, 'w'), indent=2)
print('Navattic extension', m['version'], 'pinned to', want)
EOF
  rm -rf "$ROOT/extension" && mv "$tmp/extension" "$ROOT/extension" && rm -rf "$tmp"
fi

# Claude reads a screen recording as stills, which ffmpeg pulls out.
if ! command -v ffmpeg >/dev/null; then
  if command -v brew >/dev/null; then brew install ffmpeg
  else echo "ffmpeg is missing: install it to capture from screen recordings."; fi
fi
node "$CODE/decider.mjs" | tail -1
echo "Setup done. Start the browser with: bash $CODE/browser.sh --background"
