#!/bin/sh
# Build the itch.io upload: a zip with index.html at its root.
set -e
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/castles-itch.zip
(cd web && zip -r -X ../dist/castles-itch.zip . -x '*.DS_Store')
echo "Built dist/castles-itch.zip"
