#!/usr/bin/env python3
"""Run unchanged legacy CLI behavioral assertions against the Rust executable.

The TypeScript runner is a test oracle, never a production fallback. Only spawn
targets are replaced. Schemas, hashes, boundary assertions and expected failures
remain the original tests.
"""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
binary = root / 'target/debug/gdm'
tests = sys.argv[1:] or [
    'cli.test.ts', 'cli-improvements.test.ts', 'contract.test.ts', 'delivery.test.ts', 'attempt.test.ts',
    'habit-cli.test.ts', 'habit-harvest.test.ts', 'preflight-gates.test.ts',
    'scope-gates.test.ts', 'proof-gates.test.ts', 'evidence-boundary.test.ts',
    'state-recovery.test.ts', 'work-store-lock.test.ts',
    'expected-plan-fingerprint.test.ts', 'source-fingerprint.test.ts',
    'audit-integrity.test.ts', 'protocol-cli.test.ts', 'protocol-integrity-v2.test.ts',
    'protocol-receipt.test.ts', 'protocol-concurrency.test.ts',
]
env = dict(os.environ, GDM_NATIVE_TEST_BINARY=str(binary), GDM_NATIVE_EXECUTABLE=str(binary))
if not binary.is_file():
    raise SystemExit('Build the native gdm binary first: cargo build --locked')
result = subprocess.run(
    ['bun', 'test', '--preload', str(root / 'script/qa/rust-native-preload.ts'),
     *[str(root / 'cli/test' / name) for name in tests]],
    cwd=root, env=env,
)
raise SystemExit(result.returncode)
