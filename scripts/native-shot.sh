#!/usr/bin/env bash
# Screenshot the running native AutoDesktop window (incl. the dapp webview
# overlay, which the Chrome harness can't show). Uses macOS screencapture -l
# targeting the window id found via findwin.swift.
#   Usage: scripts/native-shot.sh [name]   ->  /tmp/ad-shots/<name>.png
set -euo pipefail
name="${1:-native}"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p /tmp/ad-shots
wid="$(swift "$here/findwin.swift" auto 2>/dev/null | head -1 | cut -f1)"
if [ -z "$wid" ]; then
  echo "AutoDesktop window not found (is the app running?)" >&2
  exit 1
fi
screencapture -l"$wid" -o -x "/tmp/ad-shots/$name.png"
echo "/tmp/ad-shots/$name.png (window $wid)"
