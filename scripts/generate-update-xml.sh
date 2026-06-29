#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <extension-id> <crx-url> [output-file]" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ID="$1"
CRX_URL="$2"
OUT_FILE="${3:-$ROOT_DIR/deploy/update.xml}"
VERSION="$(jq -r '.version' "$ROOT_DIR/manifest.json")"

mkdir -p "$(dirname "$OUT_FILE")"

cat > "$OUT_FILE" <<XML
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='$APP_ID'>
    <updatecheck codebase='$CRX_URL' version='$VERSION' />
  </app>
</gupdate>
XML

echo "Wrote update manifest: $OUT_FILE"
