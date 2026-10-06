#!/usr/bin/env bash
# The native adapter owns the read-only provider argument policy.
set -euo pipefail
exec "${GDM_NATIVE_EXECUTABLE:-gdm}" provider-run --provider pi "$@"
