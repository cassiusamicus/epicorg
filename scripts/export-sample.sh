#!/bin/bash
# Regenerate docs/Outline.html from examples/Outline.org.
# Builds a private epicorg binary and serves a temporary COPY of the
# examples/*.org files on a spare port (so a running epicorg session is not
# disturbed), exports, and stops it. The server is never pointed at examples/
# itself: on startup it runs `git init` in its workspace and rotates the
# ~N~ backups, which must not happen inside the repo.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."

PORT="${EPICORG_EXPORT_PORT:-58299}"
TMP="$(mktemp -d)"
PID=""
trap '[ -n "$PID" ] && kill "$PID" 2>/dev/null; rm -rf "$TMP"' EXIT

mkdir "$TMP/ws"
cp examples/*.org "$TMP/ws/"
CGO_ENABLED=0 go build -o "$TMP/epicorg" .
"$TMP/epicorg" -addr "127.0.0.1:$PORT" -no-browser "$TMP/ws" >"$TMP/server.log" 2>&1 &
PID=$!

for _ in $(seq 1 100); do
  curl -sf "http://127.0.0.1:$PORT/api/files" >/dev/null && break
  sleep 0.1
done

node scripts/export-sample.mjs "http://127.0.0.1:$PORT" Outline.org docs/Outline.html
