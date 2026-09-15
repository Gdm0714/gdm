"""Reproduce anonymous findings uniformly; never alter the frozen primary oracle."""
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from common import HERE, active, load, save, sha

PROBE=r'''import {credentialSignature,validateDelegationRequest} from './candidate/policy.mjs';
const base={role:'scout',scope:'src',task:'inspect',deliverable:'findings',verify:'check'};
const tab='Bearer\tabcdefgh';
const aws='AKIA'+'A'.repeat(16);
const result={
 bearerTab:{rawHeuristicMatches:credentialSignature(tab),serializedHeuristicMatches:credentialSignature(JSON.stringify({...base,task:tab})),validation:validateDelegationRequest({tasks:[{...base,task:tab}]})},
 awsShape:{length:aws.length,rawHeuristicMatches:credentialSignature(aws),validation:validateDelegationRequest({tasks:[{...base,task:aws}]})},
 whitespace:{length:' '.length,validation:validateDelegationRequest({tasks:[{...base,scope:' '}]})},
 validControl:{validation:validateDelegationRequest({tasks:[base]})}
};
console.log(JSON.stringify(result));
if(!result.bearerTab.rawHeuristicMatches || result.bearerTab.serializedHeuristicMatches || result.bearerTab.validation!==null ||
 !result.awsShape.rawHeuristicMatches || typeof result.awsShape.validation!=='string' || typeof result.whitespace.validation!=='string' || result.validControl.validation!==null) process.exit(1);
'''

def main():
    run,m=active();rows=[]
    for t in load(run/'frozen/truth.json'):
        if t['family']!='effort':continue
        with tempfile.TemporaryDirectory(prefix='gdm-review-adjudication-') as tmp:
            work=Path(tmp)/'work';shutil.copytree(run/'frozen/fixtures'/t['case'],work)
            (work/'probe.mjs').write_text(PROBE)
            result=subprocess.run(['bun','./probe.mjs'],cwd=work,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
            log=HERE/'adjudication-logs'/f"{t['case']}.log";log.parent.mkdir(exist_ok=True);log.write_bytes(result.stdout)
            assert result.returncode==0,result.stdout.decode()
            rows.append({'case':t['case'],'exitCode':result.returncode,'observed':json.loads(result.stdout),
              'log':str(log.relative_to(HERE)),'logSha256':sha(result.stdout),'sourceSha256':sha((work/'candidate/policy.mjs').read_bytes())})
    save(HERE/'adjudication-probes.json',{'phase':'Anonymous finding adjudication; arm labels not yet joined',
      'primaryScoreChanged':False,'scriptSha256':sha(Path(__file__).read_bytes()),'results':rows})
    print(json.dumps(rows,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
