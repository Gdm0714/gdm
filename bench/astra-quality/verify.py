"""Verify immutable raw observations, independently regrade, then check installed parity."""
import json
from pathlib import Path
import subprocess
import tempfile
from common import HERE, ROOT, hashes, load, save, sha, parse_events, phase_evidence, trace_records, grade_snapshot
from analyze import analyze

def semantic(result):return {k:(v['exitCode'],sorted(v['passed']),sorted(v['failed'])) for k,v in result.items()}
def main():
    subprocess.run(['python3',str(HERE/'test_evidence.py')],check=True,stdin=subprocess.DEVNULL)
    subprocess.run(['python3',str(HERE/'review_findings.py')],check=True,stdin=subprocess.DEVNULL)
    pointer=load(HERE/'active-run.json');run=Path(pointer['path']);manifest=load(run/'manifest.json');f=run/'frozen'
    assert sha((run/'manifest.json').read_bytes())==pointer['manifestSha256']
    assert hashes(f)==manifest['frozenSha256'],'frozen evidence drift'
    assert sha(Path(manifest['pi']).read_bytes())==manifest['piEntrySha256'],'measured Pi executable changed'
    for name in ['run.py','common.py','fixtures.py']:
        assert sha((HERE/name).read_bytes())==manifest['frozenSha256'][name]
    expected={e['id'] for e in manifest['schedule']};assert len(expected)==12
    assert {p.parent.name for p in (run/'runs').glob('*/result.json')}==expected,'missing or extra recorded observations'
    root=Path(tempfile.mkdtemp(prefix='gdm-quality-independent-grading-'));receipt={'run':str(run),'manifestSha256':pointer['manifestSha256'],'regradeRoot':str(root),'observations':[]}
    validation=load(f/'fixtures-validation.json')
    assert hashes(Path(validation['root']))==validation['logSha256'],'fixture reference or mutation evidence drift'
    for entry in manifest['schedule']:
        log=run/'runs'/entry['id'];r=load(log/'result.json');assert all(r[k]==v for k,v in entry.items())
        for name,digest in r['artifacts'].items():assert sha((log/name).read_bytes())==digest,(entry['id'],name)
        parsed=parse_events(log/'events.jsonl')
        for key,value in parsed.items():assert r[key]==value,(entry['id'],key,'raw parse drift')
        assert hashes(log/'final-snapshot')==r['finalSnapshotSha256']
        records=trace_records(log)
        for n,record in enumerate(records):
            assert n==record['index'];assert hashes(log/'trace/snapshots'/record['snapshot'])==record['hashes'],(entry['id'],n,'snapshot drift')
            source={k:v for k,v in record['hashes'].items() if k.startswith('src/')}
            assert sha(json.dumps(source,separators=(',',':')).encode())==record['sourceHash']
        phase=phase_evidence(log,parsed,manifest['arms'][entry['arm']]);assert phase==r['phaseEvidence']
        assert r['reportedModels']==[manifest['mainModel']],entry['id']
        groups=set(validation['tasks'][entry['task']]['groups']);regrades={}
        for name,snapshot in [('final',log/'final-snapshot'),('preReview',log/'trace/snapshots'/phase['preReviewSnapshot'] if phase.get('preReviewSnapshot') else None)]:
            if snapshot is None or r['unsafe']:continue
            fresh=grade_snapshot(snapshot,f/'fixtures'/entry['task'],f/'grading'/f"{entry['task']}.test.ts",root/entry['id']/name)
            assert semantic(fresh)==semantic(r['grading'][name]),(entry['id'],name,'independent grading differs')
            observed=fresh['hidden']['passed']+fresh['hidden']['failed']
            # Compile failures can prevent groups from running; count missing groups
            # as unresolved, never fabricate passes to fill the denominator.
            assert len(observed)==len(set(observed)) and set(observed)<=groups
            if fresh['hidden']['exitCode']==0:assert set(observed)==groups
            regrades[name]=fresh
        protected=all((log/'workspace'/name).is_file() and not(log/'workspace'/name).is_symlink() and sha((log/'workspace'/name).read_bytes())==digest for name,digest in manifest['fixtureSha256'][entry['task']].items() if not name.startswith('src/'))
        assert protected==r['protectedUnchanged']
        functional=bool(regrades) and regrades['final']['hidden']['exitCode']==regrades['final']['visible']['exitCode']==0 and protected
        assert functional==r['functionalPass']
        success=bool(functional and phase['compliant'] and r['traceComplete'] and r['exitCode']==0 and not r['timeout'] and parsed['agentEnded'] and parsed['stopReason']=='stop' and r['doneMarker'] and r['workDone'])
        assert success==r['success']
        receipt['observations'].append({'id':entry['id'],'resultSha256':sha((log/'result.json').read_bytes()),'regrades':regrades,'functionalPass':functional,'workflowCompliant':phase['compliant'],'success':success})
    probe=load(HERE/'live-role-probe.json');assert probe['success']
    probe_path=Path(probe['path'])/'events.jsonl';assert sha(probe_path.read_bytes())==probe['eventsSha256']
    probe_events=[json.loads(line) for line in probe_path.read_text().splitlines() if line.strip()]
    rejected=[e for e in probe_events if e.get('type')=='tool_execution_end' and e.get('toolName')=='gdm_delegate' and e.get('result',{}).get('details',{}).get('delegation',{}).get('status')=='rejected']
    assert len(rejected)==1 and rejected[0]['isError'] is True,'actual Pi outer error flag not set'
    observed=parse_events(probe_path);assert len(observed['children'])==3 and all(c['ok'] for c in observed['children'])
    installation=load(HERE/'installation.json');assert installation['version']==load(ROOT/'cli/package.json')['version']=='0.12.1'
    assert manifest['gdmVersion']=='0.12.0'
    for record in installation['files']:assert sha(Path(record['path']).read_bytes())==record['sha256'],record['path']
    home=Path.home();assert sha((home/'.pi/agent/settings.json').read_bytes())==installation['settingsSha256']
    assert subprocess.check_output([str(home/'.local/bin/gdm'),'--version'],text=True).strip()==installation['version']
    assert installation['settings']=={'defaultProvider':'openai-codex','defaultModel':'gpt-5.6-terra','defaultThinkingLevel':'high'}
    patched={'gdm-agents/pi/delegate-runner.mjs','gdm-agents/pi/delegate-runner.d.mts','gdm-agents/pi/gdm-delegate.ts','gdm-target-manifest.json'}
    patch=load(HERE/'telemetry-patch.json')
    assert sha((HERE/'telemetry-patch.diff').read_bytes())==patch['diffSha256']
    for record in patch['files']:
        assert sha((f/'skills'/record['path']).read_bytes())==record['measuredSha256']
        assert sha((home/'.pi/agent/skills'/record['path']).read_bytes())==record['installedSourceSha256']
    deltas=[]
    for p in (f/'skills').rglob('*'):
        if not p.is_file(): continue
        name=str(p.relative_to(f/'skills'));installed=home/'.pi/agent/skills'/name
        old=sha(p.read_bytes());new=sha(installed.read_bytes())
        if name in patched:
            deltas.append({'path':name,'measuredSha256':old,'installedSha256':new})
            if name.startswith('gdm-agents/'):
                assert new==sha((ROOT/'agents'/name.removeprefix('gdm-agents/')).read_bytes())
        else: assert old==new,str(p)
    # Every other rendered byte (including role policy and model selection) must
    # match. The explicit patch receipt prevents attributing later code to old runs.
    receipt['runtimeVersions']={'measured':'0.12.0','installed':'0.12.1','reason':'Successful spawn events now distinguish process start from failed launch attempts; model routing, prompts and grading unchanged','files':deltas}
    assert sha((home/'.pi/agent/skills/gdm-agents/pi/gdm-delegate.ts').read_bytes())==probe['extensionSha256']
    analysis=analyze(run)
    assert analysis['arms']['astra_team']['roleCounts']['design']>0 and analysis['arms']['astra_team']['roleCounts']['reviewer']>0,'no actual Astra quality participation'
    receipt.update(complete=True,analysisSha256=sha((HERE/'analysis.json').read_bytes()),installationSha256=sha((HERE/'installation.json').read_bytes()),probeSha256=sha((HERE/'live-role-probe.json').read_bytes()))
    save(HERE/'verification.json',receipt)
    print('Verified 12 immutable 0.12.0 observations, independent grading and role/error probe; installed 0.12.1 differs only by the documented spawn telemetry patch')
if __name__ == "__main__":
    raise SystemExit('Retired benchmark: Pi integration was removed. Historical results are preserved; use the native GDM/gid benchmarks for new runs.')
if __name__=='__main__':main()
