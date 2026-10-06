#!/usr/bin/env bash
# Provisioning validation and lifecycle are native; host privilege setup is manual.
set -euo pipefail
exec "${GDM_NATIVE_EXECUTABLE:-${GDM_EXECUTABLE:-gdm}}" computer-use setup "$@"
