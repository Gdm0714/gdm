#!/usr/bin/env bash
set -euo pipefail

TB_BROWSER_BIN="${TERMINAL_BROWSER_BIN:-terminal-browser}"
TB_PROBE_INSTALLED=0
TB_NEW_TAB=""
TB_KEEP_TAB=0
TB_BROWSER_KEY=""
TB_ORIGINAL_TAB=""
TB_MARKER=""

tb_usage() {
  printf '%s\n' \
    'usage:' \
    '  terminal-browser-background-tab.sh open <url> [browser-key]' \
    '  terminal-browser-background-tab.sh close <browser-key> <tab-id>' >&2
  exit 2
}

tb_require_tools() {
  command -v "$TB_BROWSER_BIN" >/dev/null 2>&1 || {
    printf 'terminal-browser not found: %s\n' "$TB_BROWSER_BIN" >&2
    exit 127
  }
  command -v jq >/dev/null 2>&1 || {
    printf 'jq is required\n' >&2
    exit 127
  }
}

tb_state() {
  "$TB_BROWSER_BIN" ls --all --json
}

tb_action() {
  local tab_id="$1"
  shift
  "$TB_BROWSER_BIN" action --browser "$TB_BROWSER_KEY" --tab "$tab_id" -- "$@"
}

tb_remove_probe() {
  [ "$TB_PROBE_INSTALLED" = 1 ] || return 0
  tb_action "$TB_ORIGINAL_TAB" eval \
    "document.getElementById('$TB_MARKER')?.remove(); true" >/dev/null 2>&1 || true
  TB_PROBE_INSTALLED=0
}

tb_cleanup() {
  local exit_status=$?
  local cleanup_state=""
  set +e
  tb_remove_probe
  if [ "$exit_status" -ne 0 ] && [ -z "$TB_NEW_TAB" ] && [ -n "$TB_BROWSER_KEY" ] && [ -n "$TB_MARKER" ]; then
    cleanup_state="$(tb_state 2>/dev/null)"
    TB_NEW_TAB="$(jq -r --arg key "$TB_BROWSER_KEY" --arg url "about:blank#$TB_MARKER" '
      .browsers[]?
      | select(.key == $key)
      | .tabs[]?
      | select(.url == $url)
      | .id
    ' <<<"$cleanup_state" 2>/dev/null | head -n 1)"
  fi
  if [ "$exit_status" -ne 0 ] && [ -n "$TB_NEW_TAB" ] && [ "$TB_KEEP_TAB" = 0 ]; then
    tb_action "$TB_NEW_TAB" tab close >/dev/null 2>&1 || true
  fi
  return "$exit_status"
}

tb_open() {
  local target_url="${1:-}"
  local requested_browser="${2:-}"
  local state selection probe_url_json probe_result current_active tab_record

  [ -n "$target_url" ] || tb_usage
  state="$(tb_state)"

  if [ -n "$requested_browser" ]; then
    selection="$(jq -cer --arg key "$requested_browser" '
      [
        .browsers[]
        | select(.key == $key and .cdpPort != null)
        | . as $browser
        | $browser.tabs[]?
        | select(.active == true)
        | { key: $browser.key, tab: .id }
      ][0]
    ' <<<"$state")" || {
      printf 'no active tab in terminal-browser %s\n' "$requested_browser" >&2
      exit 1
    }
  else
    selection="$(jq -cer '
      [
        .browsers[]
        | select(.cdpPort != null)
        | . as $browser
        | $browser.tabs[]?
        | select(.active == true)
        | { key: $browser.key, tab: .id, visibleHere: $browser.inCurrentTab }
      ]
      | sort_by(.visibleHere)
      | .[0]
    ' <<<"$state")" || {
      printf '%s\n' 'no running terminal-browser with an active tab' >&2
      exit 1
    }
  fi

  TB_BROWSER_KEY="$(jq -r '.key' <<<"$selection")"
  TB_ORIGINAL_TAB="$(jq -r '.tab' <<<"$selection")"
  TB_MARKER="gdm-ai-$$-$(date +%s)"
  probe_url_json="$(jq -Rn --arg url "about:blank#$TB_MARKER" '$url')"

  trap tb_cleanup EXIT
  TB_PROBE_INSTALLED=1
  probe_result="$(tb_action "$TB_ORIGINAL_TAB" eval "(() => {
    const id = '$TB_MARKER';
    document.getElementById(id)?.remove();
    const link = document.createElement('a');
    link.id = id;
    link.href = $probe_url_json;
    link.textContent = 'gdm';
    link.style.cssText = 'position:fixed;left:8px;top:8px;width:80px;height:32px;opacity:0;z-index:2147483647;pointer-events:auto';
    (document.body || document.documentElement).appendChild(link);
    const box = link.getBoundingClientRect();
    return box.left <= 48 && box.right >= 48 && box.top <= 24 && box.bottom >= 24;
  })()")"
  [ "$probe_result" = true ] || {
    printf '%s\n' 'could not stage the background-tab probe' >&2
    exit 1
  }

  tb_action "$TB_ORIGINAL_TAB" mouse move 48 24 >/dev/null
  tb_action "$TB_ORIGINAL_TAB" mouse down middle >/dev/null
  tb_action "$TB_ORIGINAL_TAB" mouse up middle >/dev/null
  tb_remove_probe

  for _ in $(seq 1 40); do
    state="$(tb_state)"
    TB_NEW_TAB="$(jq -r --arg key "$TB_BROWSER_KEY" --arg url "about:blank#$TB_MARKER" '
      .browsers[]
      | select(.key == $key)
      | .tabs[]?
      | select(.url == $url and .active == false)
      | .id
    ' <<<"$state" | head -n 1)"
    [ -z "$TB_NEW_TAB" ] || break
    sleep 0.05
  done
  [ -n "$TB_NEW_TAB" ] || {
    printf '%s\n' 'terminal-browser did not create an inactive background tab' >&2
    exit 1
  }

  current_active="$(jq -r --arg key "$TB_BROWSER_KEY" '
    .browsers[] | select(.key == $key) | .tabs[] | select(.active == true) | .id
  ' <<<"$state")"
  [ "$current_active" = "$TB_ORIGINAL_TAB" ] || {
    printf '%s\n' 'terminal-browser changed the user active tab' >&2
    exit 1
  }

  tb_action "$TB_NEW_TAB" goto "$target_url" >/dev/null
  state="$(tb_state)"
  tab_record="$(jq -cer --arg key "$TB_BROWSER_KEY" --argjson tab "$TB_NEW_TAB" '
    .browsers[]
    | select(.key == $key)
    | .tabs[]
    | select(.id == $tab and .active == false)
  ' <<<"$state")" || {
    printf '%s\n' 'background tab was activated or disappeared during navigation' >&2
    exit 1
  }
  current_active="$(jq -r --arg key "$TB_BROWSER_KEY" '
    .browsers[] | select(.key == $key) | .tabs[] | select(.active == true) | .id
  ' <<<"$state")"
  [ "$current_active" = "$TB_ORIGINAL_TAB" ] || {
    printf '%s\n' 'terminal-browser changed the user active tab during navigation' >&2
    exit 1
  }

  TB_KEEP_TAB=1
  jq -cn \
    --arg browser "$TB_BROWSER_KEY" \
    --argjson tab "$TB_NEW_TAB" \
    --arg target "$(jq -r '.targetId // ""' <<<"$tab_record")" \
    --arg url "$(jq -r '.url' <<<"$tab_record")" \
    '{browser: $browser, tab: $tab, target: $target, url: $url, active: false}'
}

tb_close() {
  TB_BROWSER_KEY="${1:-}"
  local tab_id="${2:-}"
  [ -n "$TB_BROWSER_KEY" ] && [[ "$tab_id" =~ ^[0-9]+$ ]] || tb_usage
  "$TB_BROWSER_BIN" action --browser "$TB_BROWSER_KEY" --tab "$tab_id" -- tab close >/dev/null
  jq -cn --arg browser "$TB_BROWSER_KEY" --argjson tab "$tab_id" \
    '{browser: $browser, tab: $tab, closed: true}'
}

tb_require_tools
case "${1:-}" in
  open)
    shift
    tb_open "$@"
    ;;
  close)
    shift
    tb_close "$@"
    ;;
  *)
    tb_usage
    ;;
esac
