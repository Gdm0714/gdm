#!/usr/bin/env python3
"""Native hooks, host adapters and process-supervisor compatibility checks.

Bun supplies the original independent assertions. Product policy is called via
Rust; role-runner fixtures use the legacy Work CLI while c2 tests native protocol.
No provider, network, VM or real user configuration is used.
"""
from pathlib import Path
import os
import subprocess

root = Path(__file__).resolve().parents[2]
env = dict(os.environ, GDM_NATIVE_TEST_BINARY=str(root/'target/debug/gdm'),
           GDM_NATIVE_EXECUTABLE=str(root/'target/debug/gdm'))
commands = [
    ['bash', 'tests/integrations/run-native-hooks.sh'],
    ['bun', 'test', '--timeout', '30000', 'tests/integrations/native-contracts.test.ts'],
    ['bun', 'test', '--timeout', '30000', 'cli/test/protocol-runner-conformance.test.ts'],
]
for command in commands:
    print('+ ' + ' '.join(command), flush=True)
    subprocess.run(command, cwd=root, env=env, check=True)
print('Native integration compatibility checks passed.')
