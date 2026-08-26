#!/bin/sh
set -eu

if rg -n '#[0-9A-Fa-f]{3,8}\b' Sources/GDMNative --glob '*.swift'; then
  echo 'FAIL color literals must live only in Resources/design-tokens.css' >&2
  exit 1
fi

echo 'PASS no Swift color literals outside the canonical token file'
