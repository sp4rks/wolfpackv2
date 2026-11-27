#!/bin/sh
set -eu

usage() {
  echo "Usage: bun run deploy [--dry-run | --live | --help]"
  echo "Default: install, check, and validate a build without uploading."
  echo "--live: publish the Worker, then smoke-test its health endpoint."
}

if [ "$#" -gt 1 ]; then
  usage >&2
  exit 2
fi

case "${1---dry-run}" in
  --help) usage; exit 0 ;;
  --dry-run) mode=dry ;;
  --live) mode=live ;;
  *) usage >&2; exit 2 ;;
esac

if [ "$mode" = live ] && ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for the live health smoke test; no deployment was attempted." >&2
  exit 1
fi

bun install --frozen-lockfile
bun run check

if [ "$mode" = dry ]; then
  bun run cf deploy --dry-run
  exit 0
fi

bun run cf deploy

# -q must be first so a user's .curlrc cannot change the smoke request.
if response=$(curl -q -fsS --connect-timeout 5 --max-time 15 \
  --write-out '\n%{http_code}' \
  https://wolfpack.sprks.me/api/health) &&
  [ "$response" = "$(printf '{"message":"ok"}\n200')" ]; then
  echo "Health smoke test passed."
else
  echo "cf deploy returned success but smoke failed for https://wolfpack.sprks.me/api/health." >&2
  exit 1
fi
