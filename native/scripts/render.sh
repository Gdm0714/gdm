#!/bin/sh
set -eu

gdm_native_output='../.gdm/native-agent-activity-motion/ui'
mkdir -p "$gdm_native_output"
swift build
gdm_native_bin_dir=$(swift build --show-bin-path)
gdm_native_bin="$gdm_native_bin_dir/gdm-native"

"$gdm_native_bin" --repo .. --demo --demo-state verifying --width 1024 --height 700 \
  --screenshot "$gdm_native_output/workspace-1024-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state verifying --width 1440 --height 900 \
  --screenshot "$gdm_native_output/workspace-1440-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state verifying --width 1728 --height 1117 \
  --screenshot "$gdm_native_output/workspace-1728-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state failed-check --width 1440 --height 900 \
  --screenshot "$gdm_native_output/failed-check-1440-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state audit-rejected --width 1440 --height 900 \
  --screenshot "$gdm_native_output/audit-rejected-1440-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state empty --width 1440 --height 900 \
  --screenshot "$gdm_native_output/empty-1440-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state working --width 1440 --height 900 \
  --screenshot "$gdm_native_output/working-1440-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state waiting-input --width 1440 --height 900 \
  --screenshot "$gdm_native_output/waiting-input-1440-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state all-proven --width 1440 --height 900 \
  --screenshot "$gdm_native_output/all-proven-1440-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state audit-required --width 1440 --height 900 \
  --screenshot "$gdm_native_output/audit-required-1440-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state disconnected --width 1440 --height 900 \
  --screenshot "$gdm_native_output/disconnected-1440-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state reconnecting --width 1440 --height 900 \
  --screenshot "$gdm_native_output/reconnecting-1440-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state worktree-loop --width 1120 --height 760 \
  --screenshot "$gdm_native_output/worktree-loop-1120-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state worktree-loop-proof --width 1120 --height 760 \
  --screenshot "$gdm_native_output/worktree-loop-proof-1120-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state worktree-loop --width 1440 --height 900 \
  --screenshot "$gdm_native_output/worktree-loop-1440-dark.png"

"$gdm_native_bin" --repo .. --demo --demo-state activity-popover --width 1024 --height 700 \
  --screenshot "$gdm_native_output/agent-activity-1024-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state activity-popover --width 1120 --height 760 \
  --screenshot "$gdm_native_output/agent-activity-1120-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state activity-popover --width 1440 --height 900 \
  --screenshot "$gdm_native_output/agent-activity-1440-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state activity-popover --width 1728 --height 1117 \
  --screenshot "$gdm_native_output/agent-activity-1728-dark.png"
"$gdm_native_bin" --repo .. --demo --demo-state activity-starting --reduce-motion --width 1440 --height 900 \
  --screenshot "$gdm_native_output/agent-activity-reduced-motion-1440-static.png"

echo "PASS native screenshots rendered in $gdm_native_output"
