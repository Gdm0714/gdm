"""Failure-oriented tests for evidence accounting, final binding and owned cleanup."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from common import sha, save, parse_events, phase_evidence
from run import supervise, processes

U={'input':1,'output':1,'cacheRead':0,'cacheWrite':0,'totalTokens':2,'cost':{'total':0.001}}
M={'role':'assistant','provider':'openai-codex','model':'gpt-5.6-terra','stopReason':'stop','content':[{'type':'text','text':'done'}],'usage':U}
class Evidence(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
    def tearDown(self):self.tmp.cleanup()
    def parse(self,events):
        p=self.root/'events.jsonl';p.write_text(''.join(json.dumps(e)+'\n' for e in events));return parse_events(p)
    def test_nested_rejection_and_interrupted_usage(self):
        events=[{'type':'tool_execution_start','toolName':'gdm_delegate','toolCallId':'a','args':{'tasks':[{'role':'scout'}]}},
                {'type':'message_end','message':M},{'type':'agent_end'}]
        self.assertFalse(self.parse(events)['usageComplete'])
        events.append({'type':'tool_execution_end','toolName':'gdm_delegate','toolCallId':'a','isError':False,
                       'result':{'isError':True,'content':[{'type':'text','text':'GDM_PI_DELEGATION_REJECTED: bad request'}]}})
        r=self.parse(events);self.assertEqual(len(r['children']),0);self.assertTrue(r['delegateAttempts'][0]['rejected']);self.assertTrue(r['tools'][0]['error'])
    def phase_fixture(self):
        model='openai-codex/gpt-6-astra';(self.root/'trace').mkdir();(self.root/'workspace').mkdir();(self.root/'final-snapshot/src').mkdir(parents=True)
        (self.root/'final-snapshot/src/a.ts').write_text('fixed')
        h0={'src/a.ts':sha(b'broken'),'TASK.md':sha(b'contract')};h1={**h0,'src/a.ts':sha(b'fixed')}
        records=[]
        for i,(kind,call,role,hs) in enumerate([('start',None,None,h0),('before','d','design',h0),('after','d','design',h0),('after','edit',None,h1),('before','r','reviewer',h1),('after','r','reviewer',h1),('settled',None,None,h1)]):
            records.append({'index':i,'kind':kind,'toolCallId':call,'roles':[role] if role else [],'hashes':hs,'sourceHash':sha(json.dumps({k:v for k,v in hs.items() if k.startswith('src/')},separators=(',',':')).encode()),'unsafe':[],'snapshot':str(i)})
        (self.root/'trace/trace.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in records))
        base={'ok':True,'model':model,'reportedModels':[model],'thinking':'medium','toolCalls':[{'name':'read','path':n,'isError':False} for n in h0]}
        children=[{**base,'role':'design','toolCallId':'d','output':json.dumps({'summary':'preserve invariants','plan':['fix boundary']})},
                  {**base,'role':'reviewer','toolCallId':'r','output':json.dumps({'summary':'boundary verified','findings':[{'id':'R1','file':'src/a.ts','issue':'edge','check':'boundary assertion'}]})}]
        save(self.root/'workspace/DECISIONS.json',{'dispositions':[{'review':1,'finding':'R1','decision':'rejected','reason':'brief explicitly permits behavior'}]})
        return model,{'children':children,'delegateAttempts':[{'id':'d'},{'id':'r'}]}
    def test_complete_phases_and_late_source_mutation(self):
        model,parsed=self.phase_fixture();self.assertTrue(phase_evidence(self.root,parsed,model)['compliant'])
        (self.root/'final-snapshot/src/a.ts').write_text('changed after review')
        self.assertFalse(phase_evidence(self.root,parsed,model)['compliant'])
    def test_missing_read_and_malformed_dispositions_fail(self):
        model,parsed=self.phase_fixture();parsed['children'][1]['toolCalls']=[]
        save(self.root/'workspace/DECISIONS.json',{'dispositions':None})
        evidence=phase_evidence(self.root,parsed,model)
        self.assertFalse(evidence['compliant']);self.assertEqual(evidence['phases'][1]['missingReads'],['TASK.md','src/a.ts'])
    def test_timeout_kills_detached_child_preserves_unowned_process(self):
        sentinel=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True)
        program="import subprocess,sys,time;from pathlib import Path;p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True);Path(sys.argv[1]).write_text(str(p.pid));time.sleep(30)"
        parent=subprocess.Popen([sys.executable,'-c',program,str(self.root/'child')],start_new_session=True)
        try:
            timedout,signals=supervise(parent,1.0)
            self.assertTrue(timedout);child=int((self.root/'child').read_text())
            self.assertIn(child,{r['pid'] for r in signals});self.assertIsNone(sentinel.poll())
            self.assertNotIn(child,processes())
        finally:
            sentinel.terminate();sentinel.wait()
            if parent.poll() is None:parent.kill();parent.wait()
if __name__=='__main__':unittest.main()
