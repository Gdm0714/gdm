#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
README="$ROOT_DIR/README.md"

[[ "$(/usr/bin/sed -n '1p' "$README")" == '# Gidem' ]]
/usr/bin/grep -Fqx '<p align="center">' "$README"
if /usr/bin/grep -nE 'align="centeer"|^t$|^estee$' "$README"; then
  echo 'README contains a known corruption marker.' >&2
  exit 1
fi
[[ "$(/usr/bin/tail -n 1 "$README")" == '[MIT](./LICENSE)' ]]

printf 'README structure sanity passed: heading, centered hero, and clean footer\n'
