#!/usr/bin/env bash
set -euo pipefail

readonly BREW=/opt/homebrew/bin/brew
readonly TART=/opt/homebrew/bin/tart
readonly SOFTNET=/opt/homebrew/bin/softnet
readonly TART_LAUNCHER_SHA256=4247b559b8d3f216127bf864f00397880a79c1e16dcccfcadeec708d0f39b950
readonly TART_BINARY_SHA256=e0d71385a2974229c3e97f71862020cce4911c16c3a2fb74ab5e6f540a62131e
readonly SOFTNET_SHA256=5982c8cde55cd039d4aa71add54356224b8b8a040df1a8786f16327b421f701d
readonly VM_NAME=gdm-cu-vm
readonly IMAGE='ghcr.io/cirruslabs/macos-tahoe-base@sha256:e1863fead81cb8cf98350bc96275b7ff528119c527d16fd98cc8d5be3d9c927a'
readonly MIN_FREE_KIB=$((60 * 1024 * 1024))
readonly MARKER='gdm-computer-use-vsock-v1'
readonly MARKER_PATH='/var/db/gdm-computer-use-vsock'
readonly SETUP_VNC_PASSWORD='gdmsetup'

if [ ! -x "$TART" ]; then
  [ -x "$BREW" ] || { echo "Homebrew is required at $BREW" >&2; exit 69; }
  "$BREW" install openai/tools/tart
fi

[ -x "$SOFTNET" ] || { echo "Tart's Softnet dependency is missing at $SOFTNET" >&2; exit 69; }
tart_real="$(realpath "$TART")"
tart_binary="$(realpath "$(dirname "$tart_real")/../libexec/tart.app/Contents/MacOS/tart")"
softnet_real="$(realpath "$SOFTNET")"
[ "$("$TART" --version)" = 2.36.0 ] || { echo "Tart 2.36.0 is required" >&2; exit 1; }
[ "$(shasum -a 256 "$tart_real" | awk '{ print $1 }')" = "$TART_LAUNCHER_SHA256" ] || { echo "Tart launcher hash does not match the audited build" >&2; exit 1; }
[ "$(shasum -a 256 "$tart_binary" | awk '{ print $1 }')" = "$TART_BINARY_SHA256" ] || { echo "Tart binary hash does not match the audited build" >&2; exit 1; }
[ "$(shasum -a 256 "$softnet_real" | awk '{ print $1 }')" = "$SOFTNET_SHA256" ] || { echo "Softnet binary hash does not match the audited build" >&2; exit 1; }
if [ "$(stat -f '%u' "$softnet_real")" != 0 ] || [ ! -u "$softnet_real" ]; then
  cat >&2 <<EOF
Softnet requires its documented one-time root ownership and SUID setup.
Review the pinned binary, then run these commands in your own terminal:
  sudo chown root:wheel '$softnet_real'
  sudo chmod 4755 '$softnet_real'
Re-run this setup script afterward. No passwordless sudo rule is required.
EOF
  exit 77
fi

available_kib="$(df -Pk "$HOME" | awk 'NR == 2 { print $4 }')"
[[ "$available_kib" =~ ^[0-9]+$ ]] || { echo "Could not determine free disk space" >&2; exit 1; }
if [ "$available_kib" -lt "$MIN_FREE_KIB" ]; then
  echo "At least 60 GiB free disk is required for the isolated macOS VM" >&2
  exit 1
fi

if ! "$TART" list --source local --quiet | grep -Fxq "$VM_NAME"; then
  for attempt in 1 2 3; do
    if "$TART" clone --concurrency 1 "$IMAGE" "$VM_NAME"; then
      break
    fi
    if [ "$attempt" -eq 3 ]; then
      echo "Failed to pull the pinned macOS image after 3 attempts" >&2
      exit 1
    fi
    echo "Image pull interrupted; retrying cached layers in 30 seconds ($attempt/3)" >&2
    sleep 30
  done
fi

"$TART" set "$VM_NAME" --cpu 4 --memory 4096 --display 1280x800
if "$TART" list --source local --format json | grep -Eq '"Name"[[:space:]]*:[[:space:]]*"gdm-cu-vm"[^}]*"Running"[[:space:]]*:[[:space:]]*true'; then
  echo "Refusing to provision a Computer Use VM already running under another process" >&2
  exit 1
fi

run_stdout="$(mktemp "${TMPDIR:-/tmp}/gdm-cu-setup-out.XXXXXX")"
run_stderr="$(mktemp "${TMPDIR:-/tmp}/gdm-cu-setup-err.XXXXXX")"
run_pid=''
cleanup() {
  if [ -n "$run_pid" ] && kill -0 "$run_pid" 2>/dev/null; then
    kill -TERM "$run_pid" 2>/dev/null || true
    wait "$run_pid" 2>/dev/null || true
  fi
  rm -f "$run_stdout" "$run_stderr"
}
trap cleanup EXIT INT TERM

"$TART" run "$VM_NAME" \
  --no-graphics \
  --no-clipboard \
  --net-softnet \
  --net-softnet-block=0.0.0.0/0 \
  >"$run_stdout" 2>"$run_stderr" &
run_pid=$!

agent_ready=0
for _ in $(jot 60 1); do
  if "$TART" exec "$VM_NAME" /usr/bin/true >/dev/null 2>&1; then
    agent_ready=1
    break
  fi
  kill -0 "$run_pid" 2>/dev/null || break
  sleep 2
done
if [ "$agent_ready" -ne 1 ]; then
  echo "Tart Guest Agent did not become ready" >&2
  tail -c 1000 "$run_stderr" >&2 || true
  exit 1
fi

listeners="$(/usr/sbin/lsof -nP -a -p "$run_pid" -iTCP -sTCP:LISTEN 2>/dev/null || true)"
[ -z "$listeners" ] || { echo "Tart exposed an unexpected host TCP listener" >&2; exit 1; }

readonly KICKSTART='/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart'
"$TART" exec "$VM_NAME" /usr/bin/sudo "$KICKSTART" \
  -activate \
  -configure -access -on -users admin -privs -all \
  -clientopts -setvnclegacy -vnclegacy yes -setvncpw -vncpw "$SETUP_VNC_PASSWORD" \
  -restart -agent
"$TART" exec "$VM_NAME" /usr/bin/sudo /bin/launchctl enable system/com.apple.screensharing
"$TART" exec "$VM_NAME" /usr/bin/sudo /bin/launchctl kickstart -k system/com.apple.screensharing
"$TART" exec "$VM_NAME" /usr/bin/defaults write NSGlobalDomain AppleKeyboardUIMode -int 3
printf '%s\n' "$MARKER" | "$TART" exec -i "$VM_NAME" /usr/bin/sudo /usr/bin/tee "$MARKER_PATH" >/dev/null
"$TART" exec "$VM_NAME" /usr/bin/sudo /bin/chmod 644 "$MARKER_PATH"
written_marker="$("$TART" exec "$VM_NAME" /bin/cat "$MARKER_PATH")"
[ "$written_marker" = "$MARKER" ] || { echo "Guest identity marker readback failed" >&2; exit 1; }
"$TART" exec "$VM_NAME" /bin/sync
sleep 1

listeners="$(/usr/sbin/lsof -nP -a -p "$run_pid" -iTCP -sTCP:LISTEN 2>/dev/null || true)"
[ -z "$listeners" ] || { echo "Tart exposed an unexpected host TCP listener after provisioning" >&2; exit 1; }

kill -TERM "$run_pid"
wait "$run_pid" 2>/dev/null || true
run_pid=''
printf 'Computer Use VM ready: %s (%s, guest loopback RFB over Agent stdio)\n' "$VM_NAME" "$("$TART" --version)"
