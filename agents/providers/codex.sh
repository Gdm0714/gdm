#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: codex.sh --executable <absolute-path> --workspace <absolute-path> [--model <model>]" >&2
  exit 64
}

executable=""
workspace=""
model=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --executable)
      [ "$#" -ge 2 ] || usage
      executable="$2"
      shift 2
      ;;
    --workspace)
      [ "$#" -ge 2 ] || usage
      workspace="$2"
      shift 2
      ;;
    --model)
      [ "$#" -ge 2 ] || usage
      model="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

case "$executable" in /*) ;; *) usage ;; esac
case "$workspace" in /*) ;; *) usage ;; esac
[ -f "$executable" ] && [ -x "$executable" ] || {
  echo "PROVIDER_EXECUTABLE_INVALID: codex" >&2
  exit 69
}
[ -d "$workspace" ] || {
  echo "PROVIDER_WORKSPACE_INVALID: $workspace" >&2
  exit 66
}

argv=(
  "$executable" exec
  --ephemeral
  --ignore-user-config
  --ignore-rules
  --skip-git-repo-check
  --disable shell_tool
  --disable multi_agent
  --disable multi_agent_v2
  --disable apps
  --disable plugins
  --disable hooks
  --disable browser_use
  --disable browser_use_external
  --disable browser_use_full_cdp_access
  --disable computer_use
  --disable image_generation
  --disable in_app_browser
  --disable view_image
  --disable skill_search
  --disable tool_suggest
  --disable workspace_dependencies
  --disable code_mode_host
  --disable goals
  --disable remote_plugin
  --disable plugin_sharing
  --disable skill_mcp_dependency_install
  --disable auth_elicitation
  --disable tool_call_mcp_elicitation
  --disable unified_exec
  --disable shell_snapshot
  -c 'web_search="disabled"'
  -c 'project_doc_max_bytes=0'
  -c 'project_doc_fallback_filenames=[]'
  --sandbox read-only
  --cd "$workspace"
)
[ -z "$model" ] || argv+=(--model "$model")
argv+=(-)

cd "$workspace"
unset OLDPWD
exec "${argv[@]}"
