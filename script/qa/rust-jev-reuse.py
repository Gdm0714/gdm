#!/usr/bin/env python3
"""Run or verify the opt-in three-arm VM experiment. Never prints credentials."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import subprocess

ROOT = Path(__file__).resolve().parents[2]
ARMS = ['model_each_step', 'model_batch', 'model_reuse_jev']
SOURCE_FILES = ['model.rs', 'reuse.rs', 'reuse_benchmark.rs', 'vm.rs', 'jev.rs', 'rfb.rs']


def verify(path, repeats):
    raw = path.read_bytes()
    report = json.loads(raw)
    assert report['schemaVersion'] == 'gdm-computer-use-jev-reuse/v1'
    assert report['completed'] and report['mode'] == 'live-vm'
    assert report['credential_included'] is False
    assert report['fixture_source_sha256'] == hashlib.sha256(
        ((ROOT / 'bench/computer-use-jev/fixture.rs').read_bytes() +
         (ROOT / 'bench/computer-use-jev/stamp.rs').read_bytes())).hexdigest()
    assert report['runtime_source_sha256'] == hashlib.sha256(b''.join(
        (ROOT / 'src/computer_use' / name).read_bytes() for name in SOURCE_FILES)).hexdigest()
    rows = report['samples']
    assert len(rows) == 3 * repeats
    assert len({r['run_id'] for r in rows}) == len(rows)
    previous_complete_screen = None
    for row in rows:
        model_events = [e for e in row['events'] if e['kind'] == 'model']
        initial_screen = model_events[0].get('proposal', {}).get('observation_sha256') if model_events else None
        if initial_screen and previous_complete_screen:
            assert initial_screen != previous_complete_screen, 'Reset reused the previous finished screen'
        previous_complete_screen = (row['steps'][-1]['screen_after']
                                    if row['steps'] and row['steps'][-1]['state_after']['stage'] == 4
                                    else None)
    for arm in ARMS:
        samples = [r for r in rows if r['arm'] == arm]
        assert sorted(r['repeat'] for r in samples) == list(range(repeats))
        assert any(r['success'] for r in samples), f'No successful live execution: {arm}'
        for row in samples:
            events = row['events']
            models = [e for e in events if e['kind'] == 'model']
            jev = [e for e in events if e['kind'] == 'jev']
            assert row['model_calls'] == len(models) and row['jev_calls'] == len(jev)
            assert row['regenerations'] == len([e for e in events if e['kind'] == 'invalidate'])
            assert 0 <= row['regenerations'] <= 1
            assert row['attempt_wall_ms'] >= row['end_to_end_ms'] > 0
            assert row['end_to_end_ms'] >= sum(e['elapsed_ms'] for e in models + jev)
            assert all(e['elapsed_ms'] > 0 for e in models + jev)
            if row['success']:
                assert len(row['steps']) == 4 and row['initial_visual_sync']
                assert row['final_state']['values'] == row['expected']
                assert row['final_state']['run_id'] == row['run_id']
                assert row['final_state']['stage'] == 4 and row['verification_ms'] > 0
                assert all(e['ok'] and e['models_reported_by_cli'] and e['usage'] for e in models)
                assert row['model_calls'] == (4 if arm == 'model_each_step' else 1 + row['regenerations'])
                for i, step in enumerate(row['steps']):
                    assert step['stage'] == i and step['state_after']['stage'] == i + 1
                    assert step['visual_sync']
                    if i:
                        assert step['screen_after'] != row['steps'][i - 1]['screen_after']
                    assert step['state_after']['run_id'] == row['run_id']
                    assert step['state_after']['values'] == row['expected'][:i + 1]
                    assert step['action']['text'] == row['expected'][i] + '\n'
                    assert any(step['action'] == c['action'] for event in models
                               if event['stage'] <= i for c in event['proposal']['candidates'])
                if arm == 'model_reuse_jev':
                    assert len(jev) >= 4
                    assert all(e['selection']['model'] and e['selection']['usage'] is not None
                               for e in jev if e['ok'])
                else:
                    assert not jev
            else:
                assert row.get('error_code') or row.get('final_state')
        summary = report['summary']['arms'][arm]
        assert summary['attempts'] == repeats
        assert summary['succeeded'] == sum(bool(r['success']) for r in samples)
        assert summary['p50_ms'] == statistics.median(r['end_to_end_ms'] for r in samples)
        assert summary['model_calls'] == sum(r['model_calls'] for r in samples)
    assert any(r['arm'] == 'model_reuse_jev' and r['success'] and r['model_calls'] == 1
               and len(r['steps']) == 4 for r in rows), 'No verified pool reuse across four actions'
    if not all(r['success'] for r in rows):
        assert report['summary']['speedup_vs_each_step'] is None
        assert report['summary']['speedup_vs_batch'] is None
    print('GDM_REUSE_REPORT_BEGIN')
    print(raw.decode())
    print('GDM_REUSE_REPORT_END')
    print('report_sha256=' + hashlib.sha256(raw).hexdigest())
    print('Three-arm live evidence verified. Speedup is not a pass condition.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify', type=Path)
    parser.add_argument('--env-file', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--repeats', type=int, default=5)
    args = parser.parse_args()
    if args.verify:
        verify(args.verify, args.repeats)
        return
    assert args.env_file and args.output, 'Run requires --env-file and a new --output path'
    subprocess.run([str(ROOT / 'target/debug/gdm'), 'computer-use', 'benchmark-reuse',
                    '--live-vm', '--env-file', str(args.env_file.resolve()),
                    '--model', 'sonnet', '--repeats', str(args.repeats),
                    '--output', str(args.output.resolve())], cwd=ROOT, check=True)
    verify(args.output, args.repeats)


if __name__ == '__main__':
    main()
