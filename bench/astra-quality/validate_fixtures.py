"""Validate baselines, full reference fixes and targeted semantic mutations."""
from pathlib import Path
import tempfile
from fixtures import TASKS, TASK_IDS, materialize, oracle, mutant
from common import HERE, save, hashes, grade

def main():
    root=Path(tempfile.mkdtemp(prefix='gdm-quality-fixture-validation-'))
    report={'root':str(root),'sourceSha256':{p: h for p,h in hashes(HERE).items() if p=='fixtures.py' or p.startswith('tasks/') and p.endswith('.py')},'tasks':{}}
    for task in TASK_IDS:
        record={}; work=root/task/'baseline'; _,hidden=materialize(task,work)
        (work/'benchmark-hidden.test.ts').write_text(hidden)
        for label in ['baseline','oracle']:
            if label=='oracle': oracle(task,work)
            record[label]={k:grade(work,target,work.parent/f'{label}-{k}.log') for k,target in [('visible','./test/visible.test.ts'),('hidden','./benchmark-hidden.test.ts')]}
        assert record['baseline']['visible']['exitCode']==0,task
        assert record['baseline']['hidden']['exitCode']!=0 and record['baseline']['hidden']['failed'],task
        assert record['oracle']['visible']['exitCode']==record['oracle']['hidden']['exitCode']==0,task
        groups=record['oracle']['hidden']['passed']; assert len(groups)>=8 and len(set(groups))==len(groups),task
        record['groups']=groups; record['mutants']={}
        for name in TASKS[task]['mutants']:
            w=root/task/name;materialize(task,w);oracle(task,w);mutant(task,name,w)
            (w/'benchmark-hidden.test.ts').write_text(hidden)
            result=grade(w,'./benchmark-hidden.test.ts',w.parent/f'{name}.log')
            assert result['exitCode']!=0 and result['failed'] and set(result['failed'])<=set(groups),(task,name,result)
            record['mutants'][name]=result
        report['tasks'][task]=record
        print(task, 'groups',len(groups),'baseline failures',len(record['baseline']['hidden']['failed']),'caught mutants',len(record['mutants']),flush=True)
    report['logSha256']=hashes(root)
    save(HERE/'fixtures-validation.json',report)
if __name__=='__main__':main()
