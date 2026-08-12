#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "사용법: run-auditor.sh <codex|claude> <prompt-file> <report-file> [workspace]" >&2
  exit 64
}

[ "$#" -ge 3 ] && [ "$#" -le 4 ] || usage
provider="$1"
prompt_file="$2"
report_file="$3"
workspace="${4:-$PWD}"

[ -f "$prompt_file" ] || { echo "AUDITOR_INPUT_MISSING: $prompt_file" >&2; exit 66; }
[ -d "$workspace" ] || { echo "AUDITOR_WORKSPACE_MISSING: $workspace" >&2; exit 66; }
case "$provider" in codex|claude) ;; *) usage ;; esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
runner="$script_dir/run-role.sh"
[ -x "$runner" ] || { echo "AUDITOR_RUNNER_MISSING: $runner" >&2; exit 69; }

# The provider adapters, rather than this compatibility shim, own these exact
# capability mappings. Codex disables current supported delegation, tool, extension,
# and context-expansion features (including multi_agent, multi_agent_v2, and shell_tool).
# Claude uses --safe-mode with --tools "" and an empty strict MCP config.
# Resource accounting (`max_processes`) and owned-PID cleanup (`stop_owned_tree`)
# are implemented once in run-role.sh for every specialist role.
GDM_ROLE_MAX_SECONDS="${GDM_AUDITOR_MAX_SECONDS:-900}" \
GDM_ROLE_MAX_PROCESSES="${GDM_AUDITOR_MAX_PROCESSES:-16}" \
GDM_ROLE_MAX_RSS_KB="${GDM_AUDITOR_MAX_RSS_KB:-2097152}" \
GDM_ROLE_RESOURCE_LABEL="AUDITOR_RESOURCE_LIMIT" \
  "$runner" \
    --mode preflight \
    --provider "$provider" \
    --role audit \
    --prompt "$prompt_file" \
    --output "$report_file" \
    --workspace "$workspace"
