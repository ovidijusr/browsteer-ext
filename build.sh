#!/usr/bin/env bash
# Build the Browsteer extension bundles from source. Requires Bun >= 1.3.
set -euo pipefail
cd "$(dirname "$0")"
bun install
bun run build:prod
echo "Built: extension/dist/{content,background,popup}.js"
