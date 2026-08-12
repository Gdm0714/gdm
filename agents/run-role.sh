#!/usr/bin/env bash
set -uo pipefail

CAPABILITY_PROFILE="gdm-read-only-specialist/v1"
ADAPTER_VERSION="gdm-provider-adapter-v1"

usage() {
  cat >&2 <<'EOF'
usage:
  run-role.sh --mode work --provider <codex|claude> --role <plan|analyze|review|audit> \
    --slug <slug> --handoff-event-id <id> --claim-id <id> [--receiver-role <role>] \
    [--workspace <dir>] [--model <model>]
  run-role.sh --mode preflight --provider <codex|claude> --role <plan|analyze|review|audit> \
    --prompt <file> --output <file> [--workspace <dir>] [--model <model>]
EOF
  exit 64
}

mode=""
provider=""
role=""
slug=""
handoff_event_id=""
claim_id=""
receiver_role=""
prompt_file=""
output_file=""
workspace_input="$PWD"
model_requested=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode|--provider|--role|--slug|--handoff-event-id|--claim-id|--receiver-role|--prompt|--output|--workspace|--model)
      [ "$#" -ge 2 ] || usage
      case "$1" in
        --mode) mode="$2" ;;
        --provider) provider="$2" ;;
        --role) role="$2" ;;
        --slug) slug="$2" ;;
        --handoff-event-id) handoff_event_id="$2" ;;
        --claim-id) claim_id="$2" ;;
        --receiver-role) receiver_role="$2" ;;
        --prompt) prompt_file="$2" ;;
        --output) output_file="$2" ;;
        --workspace) workspace_input="$2" ;;
        --model) model_requested="$2" ;;
      esac
      shift 2
      ;;
    *) usage ;;
  esac
done

case "$mode" in work|preflight) ;; *) usage ;; esac
case "$provider" in codex|claude) ;; *) usage ;; esac
case "$role" in plan|analyze|review|audit) ;; *) usage ;; esac
if [ "$provider" = "claude" ]; then
  ADAPTER_VERSION="gdm-provider-adapter-v2"
fi
[ -d "$workspace_input" ] || { echo "RUNNER_WORKSPACE_INVALID: $workspace_input" >&2; exit 66; }
workspace="$(cd "$workspace_input" 2>/dev/null && pwd -P)" || {
  echo "RUNNER_WORKSPACE_INVALID: $workspace_input" >&2
  exit 66
}

if [ "$mode" = "work" ]; then
  [ -n "$slug" ] && [ -n "$handoff_event_id" ] && [ -n "$claim_id" ] || usage
  [ -z "$output_file" ] && [ -z "$prompt_file" ] || usage
  case "$slug" in
    *[!a-z0-9-]*|""|-*|*-) usage ;;
  esac
  case "$claim_id" in
    *[!A-Za-z0-9_-]*|"") usage ;;
  esac
  [ "${#claim_id}" -le 64 ] || usage
  [ -n "$receiver_role" ] || receiver_role="$role"
else
  [ -n "$prompt_file" ] && [ -n "$output_file" ] || usage
  [ -z "$slug$handoff_event_id$claim_id$receiver_role" ] || usage
fi

if [ -n "$prompt_file" ]; then
  [ -f "$prompt_file" ] && [ ! -L "$prompt_file" ] || {
    echo "RUNNER_PROMPT_INVALID: $prompt_file" >&2
    exit 66
  }
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
adapter="$script_dir/providers/$provider.sh"
[ -f "$adapter" ] && [ -x "$adapter" ] || {
  echo "RUNNER_ADAPTER_MISSING: $provider" >&2
  exit 69
}

  max_seconds="${GDM_ROLE_MAX_SECONDS:-${GDM_AUDITOR_MAX_SECONDS:-900}}"
max_processes="${GDM_ROLE_MAX_PROCESSES:-${GDM_AUDITOR_MAX_PROCESSES:-16}}"
max_rss_kb="${GDM_ROLE_MAX_RSS_KB:-${GDM_AUDITOR_MAX_RSS_KB:-2097152}}"
max_output_bytes="${GDM_ROLE_MAX_OUTPUT_BYTES:-2097152}"
max_preflight_prompt_bytes="${GDM_ROLE_MAX_PREFLIGHT_PROMPT_BYTES:-1048576}"
case "$max_seconds:$max_processes:$max_rss_kb:$max_output_bytes:$max_preflight_prompt_bytes" in
  *[!0-9:]*) echo "RUNNER_LIMIT_INVALID" >&2; exit 64 ;;
esac
[ "$max_seconds" -gt 0 ] && [ "$max_processes" -gt 0 ] && [ "$max_rss_kb" -gt 0 ] && \
  [ "$max_output_bytes" -gt 0 ] && [ "$max_preflight_prompt_bytes" -gt 0 ] || {
  echo "RUNNER_LIMIT_INVALID" >&2
  exit 64
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  else
    echo "RUNNER_SHA256_MISSING" >&2
    return 69
  fi
}

validate_preflight_prompt() {
  local file="$1" bytes without_nul
  bytes="$(wc -c <"$file" | tr -d ' ')"
  if [ "$bytes" -gt "$max_preflight_prompt_bytes" ]; then
    echo "RUNNER_PREFLIGHT_PROMPT_TOO_LARGE: $bytes > $max_preflight_prompt_bytes" >&2
    return 65
  fi
  if command -v iconv >/dev/null 2>&1; then
    iconv -f UTF-8 -t UTF-8 "$file" >/dev/null 2>&1 || {
      echo "RUNNER_PREFLIGHT_PROMPT_INVALID_UTF8" >&2
      return 65
    }
  else
    echo "RUNNER_UTF8_VALIDATOR_MISSING: iconv" >&2
    return 69
  fi
  without_nul="$(LC_ALL=C tr -d '\000' <"$file" | wc -c | tr -d ' ')"
  if [ "$without_nul" -ne "$bytes" ] || LC_ALL=C grep -q $'[\001-\010\013\014\016-\037\177]' "$file"; then
    echo "RUNNER_PREFLIGHT_PROMPT_CONTROL_BYTES" >&2
    return 65
  fi
  if LC_ALL=C grep -Eiq \
    '(^|[^[:alnum:]])sk-[[:alnum:]_-]+|ghp_|github_pat_|AKIA|Bearer |BEGIN [A-Z ]*PRIVATE KEY|[[:alnum:]_-]{8,}\.[[:alnum:]_-]{8,}\.[[:alnum:]_-]{8,}' \
    "$file"; then
    echo "RUNNER_PREFLIGHT_PROMPT_CREDENTIAL_SIGNATURE" >&2
    return 65
  fi
}

resolve_executable() {
  local override_name candidate
  case "$provider" in
    codex) override_name="GDM_CODEX_EXECUTABLE" ;;
    claude) override_name="GDM_CLAUDE_EXECUTABLE" ;;
  esac
  candidate="${!override_name-}"
  if [ -z "$candidate" ]; then
    candidate="$(command -v "$provider" 2>/dev/null || true)"
  fi
  case "$candidate" in
    /*) ;;
    *) echo "INDEPENDENCE_BLOCKED: provider executable missing: $provider" >&2; return 69 ;;
  esac
  candidate="$(realpath "$candidate" 2>/dev/null || true)"
  [ -n "$candidate" ] && [ -f "$candidate" ] && [ -x "$candidate" ] || {
    echo "INDEPENDENCE_BLOCKED: provider executable invalid: $provider" >&2
    return 69
  }
  printf '%s\n' "$candidate"
}

resolve_gdm() {
  local candidate="${GDM_EXECUTABLE:-}"
  [ -n "$candidate" ] || candidate="$(command -v gdm 2>/dev/null || true)"
  case "$candidate" in
    /*) ;;
    *) echo "RUNNER_GDM_MISSING" >&2; return 69 ;;
  esac
  candidate="$(realpath "$candidate" 2>/dev/null || true)"
  [ -n "$candidate" ] && [ -f "$candidate" ] && [ -x "$candidate" ] || {
    echo "RUNNER_GDM_INVALID" >&2
    return 69
  }
  printf '%s\n' "$candidate"
}

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/gdm-role.XXXXXX")" || exit 70
temp_dir="$(cd "$temp_dir" && pwd -P)" || exit 70
provider_workspace="$temp_dir/provider-workspace"
version_workspace="$temp_dir/version-workspace"
umask 077
mkdir -m 700 "$provider_workspace" "$version_workspace" || exit 70
child=""
claim_active=0
finish_recorded=0
output_fd_open=0
provider_executable=""
provider_sha256=""
provider_version=""
if [ "$provider" = "claude" ]; then
  argv_policy_id="gdm-claude-read-only-v2"
else
  argv_policy_id="gdm-codex-read-only-v1"
fi
output_relative=""
gdm_executable=""

descendants() {
  local root="$1" all="$1" frontier="$1" parent children next
  while [ -n "$frontier" ]; do
    next=""
    for parent in $frontier; do
      children="$(ps -axo pid=,ppid= | awk -v p="$parent" '$2 == p { print $1 }')"
      [ -z "$children" ] || next="$next $children"
    done
    [ -n "$next" ] || break
    all="$all $next"
    frontier="$next"
  done
  for parent in $all; do
    printf '%s\n' "$parent"
  done
}

stop_owned_tree() {
  local root="$1" owned pid
  [ -n "$root" ] || return 0
  owned="$(descendants "$root" 2>/dev/null || true)"
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    kill -TERM "$pid" 2>/dev/null || true
  done < <(printf '%s\n' "$owned" | awk '{p[NR]=$0} END {for(i=NR;i>=1;i--) print p[i]}')
  sleep 1
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    kill -KILL "$pid" 2>/dev/null || true
  done < <(printf '%s\n' "$owned" | awk '{p[NR]=$0} END {for(i=NR;i>=1;i--) print p[i]}')
}

monitor_exit=0
monitor_failure=""
monitor_child() {
  local root="$1" observed_output="${2:-}" output_limit="${3:-0}"
  local started now owned process_count rss_kb pid rss result output_size
  monitor_exit=0
  monitor_failure=""
  started="$(date +%s)"
  while kill -0 "$root" 2>/dev/null; do
    now="$(date +%s)"
    if [ $((now - started)) -ge "$max_seconds" ]; then
      stop_owned_tree "$root"
      wait "$root" 2>/dev/null || true
      monitor_exit=124
      monitor_failure="runner_timeout"
      return 0
    fi
    owned="$(descendants "$root")"
    process_count="$(printf '%s\n' "$owned" | wc -l | tr -d ' ')"
    rss_kb=0
    for pid in $owned; do
      rss="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
      [ -z "$rss" ] || rss_kb=$((rss_kb + rss))
    done
    if [ "$process_count" -gt "$max_processes" ]; then
      stop_owned_tree "$root"
      wait "$root" 2>/dev/null || true
      monitor_exit=70
      monitor_failure="runner_process_limit"
      return 0
    fi
    if [ "$rss_kb" -gt "$max_rss_kb" ]; then
      stop_owned_tree "$root"
      wait "$root" 2>/dev/null || true
      monitor_exit=70
      monitor_failure="runner_rss_limit"
      return 0
    fi
    if [ -n "$observed_output" ] && [ "$output_limit" -gt 0 ] && [ -f "$observed_output" ]; then
      output_size="$(wc -c <"$observed_output" | tr -d ' ')"
      if [ "$output_size" -gt "$output_limit" ]; then
        stop_owned_tree "$root"
        wait "$root" 2>/dev/null || true
        monitor_exit=70
        monitor_failure="runner_output_limit"
        return 0
      fi
    fi
    sleep 0.1
  done
  wait "$root"
  result=$?
  monitor_exit="$result"
  if [ -n "$observed_output" ] && [ "$output_limit" -gt 0 ] && [ -f "$observed_output" ]; then
    output_size="$(wc -c <"$observed_output" | tr -d ' ')"
    if [ "$output_size" -gt "$output_limit" ]; then
      monitor_exit=70
      monitor_failure="runner_output_limit"
    fi
  fi
}

finish_claim() {
  local observed_exit="$1" failure_code="${2:-}" result
  local args=(
    protocol finish
    --slug "$slug"
    --claim-id "$claim_id"
    --exit-code "$observed_exit"
    --output-artifact "$output_relative"
    --provider-target "$provider"
    --adapter-version "$ADAPTER_VERSION"
    --executable "$provider_executable"
    --executable-sha256 "$provider_sha256"
    --executable-version "$provider_version"
    --argv-policy-id "$argv_policy_id"
  )
  [ -z "$model_requested" ] || args+=(--model-requested "$model_requested")
  [ -z "$failure_code" ] || args+=(--failure-code "$failure_code")
  (cd "$workspace" && "$gdm_executable" "${args[@]}")
  result=$?
  [ "$result" -ne 0 ] || finish_recorded=1
  return "$result"
}

record_runner_failure() {
  local observed_exit="$1" failure_code="$2"
  provider_version="${provider_version:-unavailable}"
  if finish_claim "$observed_exit" "$failure_code" >"$temp_dir/finish.out" 2>"$temp_dir/finish.err"; then
    finish_recorded=1
    return 0
  fi
  sed -n '1,80p' "$temp_dir/finish.err" >&2
  return 1
}

# Invoked by the EXIT trap.
# shellcheck disable=SC2329
cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  [ -z "$child" ] || stop_owned_tree "$child"
  [ "$output_fd_open" = "0" ] || exec 3>&-
  rm -rf -- "$temp_dir"
  exit "$status"
}

# Invoked by signal traps.
# shellcheck disable=SC2329
handle_signal() {
  local code="$1"
  trap - INT TERM HUP
  [ -z "$child" ] || {
    stop_owned_tree "$child"
    wait "$child" 2>/dev/null || true
    child=""
  }
  if [ "$output_fd_open" = "1" ]; then
    exec 3>&-
    output_fd_open=0
  fi
  if [ "$mode" = "work" ] && [ "$claim_active" = "1" ] && [ "$finish_recorded" = "0" ]; then
    finish_claim "$code" "runner_interrupted" >/dev/null 2>&1 || true
  fi
  exit "$code"
}

trap cleanup EXIT
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM
trap 'handle_signal 129' HUP

if [ "$mode" = "preflight" ]; then
  validate_preflight_prompt "$prompt_file" || exit $?
fi

provider_executable="$(resolve_executable)" || exit $?
provider_sha256="$(sha256_file "$provider_executable")" || exit $?

input_file="$temp_dir/provider.in"
provider_stderr="$temp_dir/provider.err"

if [ "$mode" = "preflight" ]; then
  prompt_sha256="$(sha256_file "$prompt_file")" || exit $?
  prompt_size="$(wc -c <"$prompt_file" | tr -d ' ')"
  {
    printf '{"schemaVersion":"gdm-preflight-bundle/v1","role":"%s","capabilityProfile":"%s","promptSha256":"%s","promptBytes":%s}\n' \
      "$role" "$CAPABILITY_PROFILE" "$prompt_sha256" "$prompt_size"
    cat -- "$prompt_file"
  } >"$input_file"
  provider_output="$temp_dir/provider.out"
else
  output_relative=".gdm/$slug/out/protocol/$claim_id.out"
  output_parent="$workspace/.gdm/$slug/out/protocol"
  for component in "$workspace/.gdm" "$workspace/.gdm/$slug" "$workspace/.gdm/$slug/out"; do
    [ -d "$component" ] && [ ! -L "$component" ] || {
      echo "RUNNER_OUTPUT_PARENT_UNSAFE: $component" >&2
      exit 66
    }
  done
  if [ -e "$output_parent" ] || [ -L "$output_parent" ]; then
    [ -d "$output_parent" ] && [ ! -L "$output_parent" ] || {
      echo "RUNNER_OUTPUT_PARENT_UNSAFE: $output_parent" >&2
      exit 66
    }
  else
    mkdir "$output_parent" || {
      echo "RUNNER_OUTPUT_PARENT_CREATE_FAILED: $output_parent" >&2
      exit 70
    }
    [ -d "$output_parent" ] && [ ! -L "$output_parent" ] || {
      echo "RUNNER_OUTPUT_PARENT_UNSAFE: $output_parent" >&2
      exit 66
    }
  fi
  for component in "$workspace/.gdm" "$workspace/.gdm/$slug" "$workspace/.gdm/$slug/out" "$output_parent"; do
    [ -d "$component" ] && [ ! -L "$component" ] || {
      echo "RUNNER_OUTPUT_PARENT_UNSAFE: $component" >&2
      exit 66
    }
  done
  output_artifact="$workspace/$output_relative"
  [ ! -e "$output_artifact" ] && [ ! -L "$output_artifact" ] || {
    echo "RUNNER_OUTPUT_EXISTS: $output_relative" >&2
    exit 73
  }
  provider_output="$temp_dir/provider.out"

  gdm_executable="$(resolve_gdm)" || exit $?
  claim_args=(
    protocol claim
    --slug "$slug"
    --handoff-event-id "$handoff_event_id"
    --claim-id "$claim_id"
    --receiver-role "$receiver_role"
    --receiver-provider "$provider"
    --capability-profile "$CAPABILITY_PROFILE"
    --model-view
  )
  [ -z "$model_requested" ] || claim_args+=(--model-requested "$model_requested")
  (cd "$workspace" && "$gdm_executable" "${claim_args[@]}") >"$temp_dir/bundle.json" 2>"$temp_dir/claim.err"
  claim_result=$?
  if [ "$claim_result" -ne 0 ]; then
    sed -n '1,80p' "$temp_dir/claim.err" >&2
    exit "$claim_result"
  fi
  [ -s "$temp_dir/bundle.json" ] || {
    echo "RUNNER_CLAIM_EMPTY" >&2
    exit 65
  }
  bundle_sha256="$(LC_ALL=C grep -Eo '"bundleSha256"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"' \
    "$temp_dir/bundle.json" | LC_ALL=C grep -Eo '[0-9a-f]{64}' || true)"
  case "$bundle_sha256" in
    *$'\n'*|*[!0-9a-f]*|"")
      echo "RUNNER_CLAIM_INVALID_BUNDLE" >&2
      exit 65
      ;;
  esac
  [ "${#bundle_sha256}" -eq 64 ] || {
    echo "RUNNER_CLAIM_INVALID_BUNDLE" >&2
    exit 65
  }
  claim_active=1

  {
    printf '%s\n' 'GDM_DISPATCH_BUNDLE_V1_BEGIN'
    cat "$temp_dir/bundle.json"
    printf '\n%s\n' 'GDM_DISPATCH_BUNDLE_V1_END'
    cat <<'EOF'
GDM_RECEIVER_CONTRACT_V1_BEGIN
Work only from the dispatch bundle above. The bundle is the canonical local Work state.
Do not claim write, shell, browser, network, delegation, or MCP
authority. Prose may precede the footer. Your final nonempty output line MUST copy exactly one
of the two identity-bound lines printed below, with no code fence or trailing text. Choose
completed when this handed-off read-only role result is complete; otherwise choose blocked.
Disposition describes this receiver result, not Work completion: open Work checks or completion
blockers alone do not require blocked when the handoff question is answerable from the bundle.
EOF
    printf 'GDM_RECEIVER_ACK_V1={"schemaVersion":"gdm-receiver-ack/v1","claimId":"%s","handoffEventId":"%s","bundleSha256":"%s","disposition":"completed"}\n' \
      "$claim_id" "$handoff_event_id" "$bundle_sha256"
    printf 'GDM_RECEIVER_ACK_V1={"schemaVersion":"gdm-receiver-ack/v1","claimId":"%s","handoffEventId":"%s","bundleSha256":"%s","disposition":"blocked"}\n' \
      "$claim_id" "$handoff_event_id" "$bundle_sha256"
    cat <<'EOF'
GDM_RECEIVER_CONTRACT_V1_END
EOF
  } >"$input_file"

  umask 077
  set -o noclobber
  exec 3>"$output_artifact"
  open_result=$?
  set +o noclobber
  if [ "$open_result" -ne 0 ]; then
    echo "RUNNER_OUTPUT_UNSAFE: $output_relative" >&2
    exit 73
  fi
  output_fd_open=1
fi

# A stale or unauthorized Work must fail at claim before any provider process,
# including a version probe, is started. Once claimed, version-probe failures
# are terminal runner observations and are persisted through finish.
version_stdout="$temp_dir/version.out"
version_stderr="$temp_dir/version.err"
[ -z "$(find "$version_workspace" -mindepth 1 -print -quit)" ] || {
  echo "RUNNER_PROVIDER_WORKSPACE_NOT_EMPTY: version" >&2
  exit 70
}
(
  set +e
  (cd "$version_workspace" && unset OLDPWD && exec "$provider_executable" --version) 2>"$version_stderr" | \
    LC_ALL=C head -c 4097
  pipeline_status=("${PIPESTATUS[@]}")
  exit "${pipeline_status[0]}"
) >"$version_stdout" &
child=$!
monitor_child "$child" "$version_stdout" 4096
child=""
version_exit="$monitor_exit"
version_failure="$monitor_failure"
if [ -z "$version_failure" ] && [ "$version_exit" -eq 0 ]; then
  if [ ! -s "$version_stdout" ]; then
    version_exit=69
    version_failure="provider_version_empty"
  else
    version_lines="$(awk 'END { print NR }' "$version_stdout")"
    provider_version="$(LC_ALL=C sed '1s/^[[:space:]]*//; $s/[[:space:]]*$//' "$version_stdout")"
    version_bytes="$(printf '%s' "$provider_version" | wc -c | tr -d ' ')"
    if [ "$version_lines" -ne 1 ] || [ -z "$provider_version" ] || [ "$version_bytes" -gt 240 ] || \
      printf '%s' "$provider_version" | LC_ALL=C grep -Eq \
        '[^ -~]|(^|[^[:alnum:]])sk-[[:alnum:]_-]+|ghp_|github_pat_|AKIA|Bearer |BEGIN [A-Z ]*PRIVATE KEY|[[:alnum:]_-]{8,}\.[[:alnum:]_-]{8,}\.[[:alnum:]_-]{8,}'; then
      version_exit=69
      version_failure="provider_version_invalid"
      provider_version=""
    fi
  fi
elif [ -z "$version_failure" ]; then
  version_failure="provider_version_unavailable"
fi
if [ -n "$version_failure" ]; then
  [ "$output_fd_open" = "0" ] || {
    exec 3>&-
    output_fd_open=0
  }
  if [ "$mode" = "work" ]; then
    provider_version="unavailable"
    record_runner_failure "$version_exit" "$version_failure" || true
  fi
  sed -n '1,40p' "$version_stderr" >&2
  if [[ "$version_failure" == runner_* ]]; then
    label="${GDM_ROLE_RESOURCE_LABEL:-ROLE_RESOURCE_LIMIT}"
    echo "$label: $version_failure" >&2
  else
    echo "INDEPENDENCE_BLOCKED: provider version unavailable: $provider" >&2
  fi
  exit "$version_exit"
fi

[ -z "$(find "$provider_workspace" -mindepth 1 -print -quit)" ] || {
  echo "RUNNER_PROVIDER_WORKSPACE_NOT_EMPTY: execution" >&2
  if [ "$mode" = "work" ]; then
    [ "$output_fd_open" = "0" ] || {
      exec 3>&-
      output_fd_open=0
    }
    record_runner_failure 70 "runner_workspace_not_empty" || true
  fi
  exit 70
}
adapter_args=(--executable "$provider_executable" --workspace "$provider_workspace")
[ -z "$model_requested" ] || adapter_args+=(--model "$model_requested")
(
  set +e
  "$adapter" "${adapter_args[@]}" <"$input_file" 2>"$provider_stderr" | \
    LC_ALL=C head -c $((max_output_bytes + 1))
  pipeline_status=("${PIPESTATUS[@]}")
  exit "${pipeline_status[0]}"
) >"$provider_output" &
child=$!
monitor_child "$child" "$provider_output" "$max_output_bytes"
child=""

if [ "$output_fd_open" = "1" ]; then
  if [ "$monitor_failure" = "runner_output_limit" ]; then
    failure_output=$'GDM_RUNNER_FAILURE: provider output exceeded configured byte limit\n'
    printf '%s' "${failure_output:0:max_output_bytes}" >&3
  else
    cat -- "$provider_output" >&3
  fi
  exec 3>&-
  output_fd_open=0
fi

provider_exit="$monitor_exit"
failure_code=""
if [ -n "$monitor_failure" ]; then
  failure_code="$monitor_failure"
elif [ "$provider_exit" -ne 0 ]; then
  failure_code="provider_exit_nonzero"
fi

provider_post_sha256="$(sha256_file "$provider_executable" 2>/dev/null || true)"
if [ "$provider_post_sha256" != "$provider_sha256" ]; then
  provider_exit=70
  failure_code="provider_executable_changed"
fi

if [ "$mode" = "preflight" ]; then
  if [ "$failure_code" = "provider_executable_changed" ]; then
    echo "INDEPENDENCE_BLOCKED: provider executable changed during run: $provider" >&2
    exit 70
  fi
  if [ "$provider_exit" -ne 0 ]; then
    sed -n '1,80p' "$provider_stderr" >&2
    if grep -Eiq 'quota|rate.?limit|auth|login|unauthorized|forbidden|credential' "$provider_stderr"; then
      echo "INDEPENDENCE_BLOCKED: provider authentication or quota failure: $provider" >&2
    elif [ -n "$monitor_failure" ]; then
      label="${GDM_ROLE_RESOURCE_LABEL:-ROLE_RESOURCE_LIMIT}"
      echo "$label: $monitor_failure" >&2
    else
      echo "INDEPENDENCE_BLOCKED: provider execution failed: $provider exit=$provider_exit" >&2
    fi
    exit "$provider_exit"
  fi
  [ -s "$provider_output" ] || {
    echo "RECEIVER_EMPTY_OUTPUT: $provider" >&2
    exit 65
  }
  output_parent="$(dirname "$output_file")"
  mkdir -p "$output_parent" || exit 70
  [ -d "$output_parent" ] && [ ! -L "$output_file" ] || {
    echo "RUNNER_OUTPUT_UNSAFE: $output_file" >&2
    exit 73
  }
  mv -f -- "$provider_output" "$output_file" || exit 70
  exit 0
fi

finish_claim "$provider_exit" "$failure_code" >"$temp_dir/finish.out" 2>"$temp_dir/finish.err"
finish_result=$?
if [ -s "$temp_dir/finish.out" ]; then
  cat "$temp_dir/finish.out"
fi
if [ "$finish_result" -ne 0 ]; then
  sed -n '1,80p' "$temp_dir/finish.err" >&2
  exit "$finish_result"
fi
finish_recorded=1

if [ "$provider_exit" -ne 0 ]; then
  sed -n '1,80p' "$provider_stderr" >&2
  if grep -Eiq 'quota|rate.?limit|auth|login|unauthorized|forbidden|credential' "$provider_stderr"; then
    echo "INDEPENDENCE_BLOCKED: provider authentication or quota failure: $provider" >&2
  elif [ -n "$monitor_failure" ]; then
    echo "ROLE_RESOURCE_LIMIT: $monitor_failure" >&2
  fi
  exit "$provider_exit"
fi

exit 0
