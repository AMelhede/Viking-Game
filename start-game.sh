#!/usr/bin/env bash
# Launches the Viking Game on http://localhost:8000 and opens it in the default browser.
# Local server is required because the biosignal SDK needs a secure context (Web Bluetooth, camera).

set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org and try again." >&2
  exit 1
fi

URL="http://localhost:8000/"
case "$(uname -s)" in
  Darwin) open "$URL" ;;
  Linux)  xdg-open "$URL" >/dev/null 2>&1 || true ;;
  MINGW*|MSYS*|CYGWIN*) start "" "$URL" ;;
esac

exec node server.js 8000
