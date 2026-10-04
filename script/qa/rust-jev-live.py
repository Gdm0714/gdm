#!/usr/bin/env python3
"""Opt-in live VM/model experiment; credentials are passed by path, never printed."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--env-file', required=True)
parser.add_argument('--repeats', type=int, default=3)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
binary = root / 'target/debug/gdm'
with tempfile.TemporaryDirectory(prefix='gdm-jev-proof-') as temporary:
    output = Path(temporary) / 'result.json'
    result = subprocess.run([
        str(binary), 'computer-use', 'benchmark', '--live-vm',
        '--env-file', str(Path(args.env_file).resolve()), '--model', 'sonnet',
        '--repeats', str(args.repeats), '--output', str(output),
    ], cwd=root)
    if output.exists():
        raw = output.read_bytes()
        print('GDM_LIVE_REPORT_BEGIN', flush=True)
        print(raw.decode(), flush=True)
        print('GDM_LIVE_REPORT_END', flush=True)
        print('report_sha256=' + hashlib.sha256(raw).hexdigest(), flush=True)
    assert result.returncode == 0, 'Live experiment did not complete'
    report = json.loads(raw)
    assert report['completed'] and report['mode'] == 'live-vm'
    assert len(report['samples']) == args.repeats * 2
    for arm in ['model_direct', 'model_candidates_jev']:
        rows = [s for s in report['samples'] if s['arm'] == arm]
        assert len(rows) == args.repeats
        assert any(s['success'] for s in rows), f'No verified execution for {arm}'
        assert all(s['end_to_end_ms'] > 0 and s['attempt_wall_ms'] > 0 for s in rows)
    assert any(s.get('selection_ms', 0) > 0 for s in report['samples']
               if s['arm'] == 'model_candidates_jev'), 'No actual Jev timing'
    print('Live measured comparison captured; speedup is not a pass criterion.', flush=True)
