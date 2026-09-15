"""Post-freeze source-discovered loader concern; separate from target-fault score.

This probe is applied to BOTH persistence variants before reading reviewer output.
The packet calls the loader unchanged, but includes it in the reconstructed addition
and states that non-string-valued JSON must be rejected. Preserve that scope
ambiguity in adjudication; execution alone does not decide whether it was in scope.
"""
import shutil
import subprocess
import tempfile
from pathlib import Path
from common import HERE, active, load, save, sha

PROBE='''import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {loadPresets} from './cli/src/store.ts';
test('exploratory: loader rejects non-string-valued JSON',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'review-loader-'));
 try {mkdirSync(join(cwd,'.gdm'));
 writeFileSync(join(cwd,'.gdm/presets.json'),JSON.stringify({bad:123}));
 expect(()=>loadPresets(cwd)).toThrow();
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
test('exploratory control: loader accepts valid string-valued JSON',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'review-loader-'));
 try {mkdirSync(join(cwd,'.gdm'));
 writeFileSync(join(cwd,'.gdm/presets.json'),JSON.stringify({good:'echo okay'}));
 expect(loadPresets(cwd)).toEqual({good:'echo okay'});
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
'''

def main():
    run,m=active();rows=[]
    for t in load(run/'frozen/truth.json'):
        if t['family']!='atomic':continue
        with tempfile.TemporaryDirectory(prefix='gdm-review-exploratory-') as tmp:
            work=Path(tmp)/'work';shutil.copytree(run/'frozen/fixtures'/t['case'],work)
            (work/'extra.test.ts').write_text(PROBE)
            result=subprocess.run(['bun','test','./extra.test.ts'],cwd=work,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
            log=HERE/'exploratory-logs'/f"{t['case']}.log";log.parent.mkdir(exist_ok=True);log.write_bytes(result.stdout)
            rows.append({'case':t['case'],'exitCode':result.returncode,'log':str(log.relative_to(HERE)),
                         'logSha256':sha(result.stdout),'sourceSha256':sha((work/'cli/src/store.ts').read_bytes())})
    receipt={'timing':'Post-freeze source inspection, before reading anonymous review contents',
             'primaryScoreChanged':False,'scopeAmbiguity':'Loader is in candidate addition and has an explicit validation contract, but is described as unchanged.',
             'scriptSha256':sha(Path(__file__).read_bytes()),'probeSha256':sha(PROBE.encode()),'results':rows}
    save(HERE/'exploratory-loader.json',receipt)
    print(receipt)

if __name__=='__main__':main()
