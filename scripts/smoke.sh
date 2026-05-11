#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build

if [ ! -f docs/index.html ]; then
  echo "smoke: docs/index.html missing"
  exit 1
fi
if ! ls docs/assets/*.js >/dev/null 2>&1; then
  echo "smoke: no JS bundle in docs/assets"
  exit 1
fi
echo "smoke: OK"
