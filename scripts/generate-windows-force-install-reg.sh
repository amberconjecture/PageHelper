#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <extension-id> <update-xml-url> [output-file]" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSION_ID="$1"
UPDATE_XML_URL="$2"
OUT_FILE="${3:-$ROOT_DIR/deploy/windows-install-force.reg}"

if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Extension ID must be 32 lowercase characters from a to p." >&2
  exit 1
fi

if [[ ! "$UPDATE_XML_URL" =~ ^https?:// ]]; then
  echo "Update XML URL must start with http:// or https://." >&2
  exit 1
fi

if [[ "$UPDATE_XML_URL" == *\"* ]]; then
  echo "Update XML URL must not contain double quotes." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT_FILE")"

{
  printf 'Windows Registry Editor Version 5.00\r\n'
  printf '\r\n'
  printf '[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist]\r\n'
  printf '"1"="%s;%s"\r\n' "$EXTENSION_ID" "$UPDATE_XML_URL"
} > "$OUT_FILE"

echo "Wrote Windows force-install registry file: $OUT_FILE"
echo "Distribute this .reg file to Windows users and import it with administrator rights."
