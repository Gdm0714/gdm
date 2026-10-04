#!/usr/bin/env bash
# Provider-neutral role lifecycle and resource supervision live in Rust.
set -euo pipefail
exec "${GDM_NATIVE_EXECUTABLE:-gdm}" role-run "$@"
