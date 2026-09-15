#!/usr/bin/env python3
"""Apply one documented, uniform grading correction without rerunning any model."""
from pathlib import Path
import re
import shutil
import tempfile
from fixtures import apply_oracle
from run import HERE, load, save, sha, run_test


def corrected_test(run):
    record = load(HERE / 'grader-correction.json')
    assert record['run'] == str(run) and record['task'] == 't4'
    original = (run / 'frozen/grading/t4.test.ts').read_text()
    corrected = (HERE / 'grading-correction-t4.test.ts').read_text()
    assert sha(original.encode()) == record['originalSha256']
    assert sha(corrected.encode()) == record['correctedSha256']
    assert original.count(record['originalAssertion']) == 1
    assert original.replace(record['originalAssertion'], record['correctedAssertion']) == corrected
    return corrected


def validate(run):
    corrected = corrected_test(run)
    records = []
    with tempfile.TemporaryDirectory(prefix='gdm-routing-grader-validation-') as td:
        root = Path(td)
        for variant in ['broken', 'invalidate', 'write-through']:
            work = root / variant
            source = (run / 'runs/t4-legacy-1/workspace') if variant == 'write-through' else (run / 'frozen/fixtures/t4')
            shutil.copytree(source, work, ignore=shutil.ignore_patterns('.git', '.gdm'))
            if variant == 'invalidate':
                apply_oracle('t4', work)
            (work / 'benchmark-hidden.test.ts').write_text(corrected)
            result = run_test(work, './benchmark-hidden.test.ts', root / f'{variant}.txt')
            assert (result['exitCode'] == 0) == (variant != 'broken'), variant
            records.append({'variant': variant, 'exitCode': result['exitCode'], 'output': (root / f'{variant}.txt').read_text()})
    save(HERE / 'grader-correction-validation.json', {'run': str(run), 'checks': records})
    return records


def adjudicate(run, rows):
    corrected = corrected_test(run)
    expected_tests = len(re.findall(r'\btest\s*\(', corrected))
    logs = run / 'adjudication'
    logs.mkdir(exist_ok=True)
    records = []
    corrected_rows = []
    with tempfile.TemporaryDirectory(prefix='gdm-routing-adjudication-') as td:
        for row in rows:
            result = dict(row)
            if row['task'] == 't4':
                work = Path(td) / row['id']
                shutil.copytree(run / 'runs' / row['id'] / 'workspace', work, ignore=shutil.ignore_patterns('.git', '.gdm'))
                original = run / 'frozen/fixtures/t4'
                for name in ['test/visible.test.ts', 'package.json']:
                    shutil.copyfile(original / name, work / name)
                (work / 'benchmark-hidden.test.ts').write_text(corrected)
                output = logs / f"{row['id']}.txt"
                result['hidden'] = run_test(work, './benchmark-hidden.test.ts', output)
                if result['hidden']['exitCode'] == 0:
                    assert re.search(rf'\b{expected_tests} pass\b', output.read_text())
                    assert re.search(r'\b0 fail\b', output.read_text())
                result['success'] = (row['exitCode'] == 0 and not row['timeout'] and row['agentEnded']
                    and row['stopReason'] == 'stop' and result['hidden']['exitCode'] == 0
                    and row['visible']['exitCode'] == 0 and row['protectedUnchanged'] and row['doneMarker'] and row['workDone'])
                shutil.rmtree(work)
            records.append({'id': row['id'], 'originalSuccess': row['success'], 'correctedSuccess': result['success'],
                'originalHiddenExitCode': row['hidden']['exitCode'], 'correctedHiddenExitCode': result['hidden']['exitCode'],
                'correctionApplied': row['task'] == 't4', 'correctedOutputSha256': result['hidden']['sha256']})
            corrected_rows.append(result)
    save(HERE / 'adjudication.json', {'schema': 'gdm-pi-adjudication/v1', 'run': str(run),
        'correctionSha256': sha((HERE / 'grader-correction.json').read_bytes()),
        'completed': len(rows), 'originalSuccesses': sum(r['success'] for r in rows),
        'correctedSuccesses': sum(r['success'] for r in corrected_rows), 'outcomes': records})
    return corrected_rows


if __name__ == '__main__':
    run = Path(load(HERE / 'active-run.json')['path'])
    validate(run)
    rows = [load(p) for p in sorted((run / 'runs').glob('*/result.json'))]
    result = adjudicate(run, rows)
    print(f'Original success: {sum(r["success"] for r in rows)}/{len(rows)}; corrected success: {sum(r["success"] for r in result)}/{len(result)}')
