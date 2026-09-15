import tempfile
import unittest
from pathlib import Path
from run import parse
from analyze import metrics
from common import function

class EvidenceTests(unittest.TestCase):
    def test_destructured_function_signature_keeps_the_body(self):
        source='export async function run({\n  x,\n}) {\n  return x;\n}\n'
        self.assertEqual(function(source,'run'),source)

    def test_empty_and_provider_failure_are_not_reviews(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'events';p.write_text('not-json\n')
            r=parse(p);self.assertFalse(r['responseValid']);self.assertFalse(r['agentEnded']);self.assertEqual(r['invalidJsonLines'],1)

    def test_misses_false_alarms_and_unresolved_remain_separate(self):
        truth={'bug':{'family':'sample','defective':True,'severity':'high'},'clean':{'family':'sample','defective':False,'severity':'high'}}
        rows=[];adj=[]
        for arm in ['terra','astra']:
            for case in truth:
                for rep in [1,2]:
                    rid=f'{arm}-{case}-{rep}'
                    rows.append({'id':rid,'arm':arm,'case':case,'repetition':rep,'transportSuccess':True,'responseValid':True,
                                 'seconds':1,'usageComplete':True,'usage':{'apiCostEstimateUSD':.1,'totalTokens':10}})
                    if arm=='astra' and case=='bug':adj.append({'review':rid,'label':'known_true_positive'})
                    if arm=='terra' and case=='clean':adj.append({'review':rid,'label':'unsupported'})
                    if arm=='astra' and case=='clean':adj.append({'review':rid,'label':'unresolved'})
        r=metrics(rows,truth,adj)
        self.assertEqual(r['arms']['terra']['knownDetected'],0)
        self.assertEqual(r['arms']['terra']['controlFalseAlarmRuns'],2)
        self.assertEqual(r['arms']['astra']['knownDetected'],2)
        self.assertEqual(r['arms']['astra']['precisionLower'],.5)
        self.assertEqual(r['arms']['astra']['precisionUpper'],1)
        self.assertEqual(r['arms']['astra']['controlFalseAlarmRuns'],0)
        self.assertEqual(len(r['pairs']),4)

if __name__=='__main__':unittest.main()
