#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
KEY_PATH="${1:-$ROOT_DIR/private/page-helper.pem}"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/dist}"
BUILD_DIR="$OUT_DIR/page-helper"
VERSION="$(jq -r '.version' "$ROOT_DIR/manifest.json")"

if [[ ! -x "$CHROME_BIN" ]]; then
  echo "Chrome executable not found: $CHROME_BIN" >&2
  echo "Set CHROME_BIN to your Chrome/Chromium executable path." >&2
  exit 1
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cp "$ROOT_DIR/manifest.json" "$BUILD_DIR/manifest.json"
cp -R "$ROOT_DIR/src" "$BUILD_DIR/src"

if [[ -f "$KEY_PATH" ]]; then
  "$CHROME_BIN" --pack-extension="$BUILD_DIR" --pack-extension-key="$KEY_PATH"
else
  echo "Private key not found, creating a first-time package and key."
  "$CHROME_BIN" --pack-extension="$BUILD_DIR"

  if [[ -f "$OUT_DIR/page-helper.pem" ]]; then
    mkdir -p "$(dirname "$KEY_PATH")"
    mv "$OUT_DIR/page-helper.pem" "$KEY_PATH"
    chmod 600 "$KEY_PATH"
    echo "Generated private key: $KEY_PATH"
    echo "Keep this file secure. Reuse it for every future release."
  fi
fi

if [[ -f "$OUT_DIR/page-helper.crx" ]]; then
  mv "$OUT_DIR/page-helper.crx" "$OUT_DIR/page-helper-$VERSION.crx"
  echo "Created CRX: $OUT_DIR/page-helper-$VERSION.crx"
else
  echo "Chrome did not produce $OUT_DIR/page-helper.crx" >&2
  exit 1
fi
