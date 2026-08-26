#!/bin/sh
set -eu

node <<'NODE'
const fs = require('fs');
const css = fs.readFileSync('Sources/GDMNative/Resources/design-tokens.css', 'utf8');
const tokens = Object.fromEntries(
  [...css.matchAll(/(--[a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)].map(([, key, value]) => [key, value])
);
const luminance = hex => {
  const channels = [1, 3, 5]
    .map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const ratio = (foreground, background) => {
  const a = luminance(tokens[foreground]);
  const b = luminance(tokens[background]);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const checks = [
  ['--text-strong', '--surface-panel', 4.5],
  ['--text-primary', '--surface-panel', 4.5],
  ['--text-secondary', '--surface-panel', 4.5],
  ['--text-tertiary', '--surface-panel', 4.5],
  ['--signal-proven', '--surface-panel', 4.5],
  ['--signal-active', '--surface-panel', 4.5],
  ['--signal-attention', '--surface-panel', 4.5],
  ['--signal-blocked', '--surface-panel', 4.5],
  ['--signal-proven', '--surface-terminal', 4.5],
  ['--signal-active', '--surface-terminal', 4.5],
  ['--signal-attention', '--surface-terminal', 4.5],
  ['--signal-blocked', '--surface-terminal', 4.5],
  ['--line-control', '--surface-panel', 3.0]
];
let failed = false;
for (const [foreground, background, threshold] of checks) {
  const measured = ratio(foreground, background);
  const pass = measured >= threshold;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${foreground} on ${background}: ${measured.toFixed(2)}:1 (>= ${threshold})`);
  failed ||= !pass;
}
process.exit(failed ? 1 : 0);
NODE
