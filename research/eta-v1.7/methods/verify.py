"""Verify the public packet and optionally join its G evaluation calls to numeric data.
Only reads files; stdlib Python 3.10+, no model/account/network access.
These checks do not independently authenticate private original evidence.
"""
import argparse,hashlib,json
from collections import Counter,defaultdict
from pathlib import Path

ROOT=Path(__file__).resolve().parent
def load(name):return json.loads((ROOT/name).read_text(encoding='utf-8-sig'))
def sha(b):return hashlib.sha256(b).hexdigest()
count=0
def check(value,message):
 global count
 if not value:raise ValueError(message)
 count+=1
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--numeric',type=Path);args=parser.parse_args()
 manifest=load('MANIFEST.json')
 actual={p.relative_to(ROOT).as_posix() for p in ROOT.rglob('*') if p.is_file() and p.name!='MANIFEST.json'}
 expected={r['path'] for r in manifest['files']}
 check(actual==expected,'Published file inventory differs')
 for r in manifest['files']:
  p=(ROOT/r['path']).resolve();check(p.is_relative_to(ROOT),'Path escapes packet')
  b=p.read_bytes();check(len(b)==r['bytes'] and sha(b)==r['sha256'],'File integrity: '+r['path'])
 contract=load('prompts/REQUEST-CONTRACT.json')
 check(sha((ROOT/'prompts/G-observed-developer.txt').read_bytes())==contract['developerSha256'],'Prompt pin')
 check(sha((ROOT/'prompts/G-observed-output-schema.json').read_bytes())==contract['outputSchemaSha256'],'Schema pin')
 provenance=load('PROVENANCE.json')
 check(sha((ROOT/'builders/canonical.mjs').read_bytes())==provenance['sourcePins']['G-original-canonical-builder']['sha256'],'Original builder pin')
 inv=load('audit/G-input-inventory.json');pairs=load('audit/G-paired-structures.json');calls=load('audit/G-call-inventory.json')
 check((len(inv),len(pairs),len(calls))==(72,36,144),'G population')
 key=lambda r:(r['task'],r['anchor'])
 grouped=defaultdict(list)
 for r in inv:grouped[key(r)].append(r)
 for p in pairs:
  group=grouped[key(p)];check(len(group)==2 and {r['condition'] for r in group}=={'activity','full'},'Paired arms')
  a=next(r for r in group if r['condition']=='activity');f=next(r for r in group if r['condition']=='full')
  for field in ('task','repository','trajectory','stage','anchor','activeSeconds','fields','messageRoles','activityEvents','historyComplete','previousEstimate'):
   check(a[field]==f[field],'Common field: '+field)
  check(a['contentEvents']==0 and f['contentEvents']==len(p['activity']),'Content contrast')
  check(p['activityArmExecutionContent']==[] and p['actualTextIncluded'] is False,'Text omission declaration')
  check(all(e['elapsedSeconds']<=p['activeSeconds'] for e in p['activity']),'Future activity event')
  eventkeys=[(e['id'],e['phase']) for e in p['activity']]
  check(len(set(eventkeys))==len(eventkeys) and p['duplicateIdentities']==0,'Duplicate canonical identity')
  check(eventkeys==[(e['id'],e['phase']) for e in p['contentArmEventStructure']],'Content identity match')
  check(p['latestEventElapsedSeconds']==max(e['elapsedSeconds'] for e in p['activity']),'Latest visible clock')
 check({c['ordinal'] for c in calls}==set(range(1,145)),'All ordinal slots')
 check(Counter(c['stage'] for c in calls)=={'calibration':48,'evaluation':96},'Stage calls')
 train={c['repository'] for c in calls if c['stage']=='calibration'};test={c['repository'] for c in calls if c['stage']=='evaluation'}
 check(len(train)==4 and len(test)==8 and not train&test,'Training/evaluation repositories')
 slots=Counter((c['task'],c['anchor'],c['condition'],c['repeat']) for c in calls)
 check(len(slots)==144 and all(v==1 for v in slots.values()),'Distinct request slots')
 check(sum(c['knownTokens'] for c in calls)==4091756,'Known token total')
 for c in calls:
  check(c['developerSha256']==contract['developerSha256'] and c['responseSchemaSha256']==contract['outputSchemaSha256'],'Common request contract')
  check(all(c[k] for k in ('frozenFieldsPreserved','wireMatchesPrepared','freshSession','settledAndReleased')),'Published call-check flags')
 old=load('audit/EF-input-inventory.json');oldcalls=load('audit/EF-call-inventory.json')
 check(len(old)==299 and Counter(r['study'] for r in oldcalls)=={'E':132,'F':400},'Prior audit metadata population')
 for study,expectedfull in [('E',33),('F',80)]:
  full=[r for r in old if r['study']==study and r['condition']=='full']
  check(len(full)==expectedfull and all(r['duplicateResultPairs']>0 for r in full),'Legacy duplicate result audit '+study)
 fni=[r for r in old if r['study']=='F' and r['condition']!='initial']
 check(len(fni)==160 and all(r['informationArmLabelVisible'] for r in fni),'F information labels')
 demo=load('examples/synthetic-pairs.json');check(demo['synthetic'] and not demo['historicalPredictions'],'Synthetic declaration')
 for p in demo['pairs']:
  body=lambda arm:json.loads(p[arm]['messages'][1]['text'].split('\n',1)[1])
  a,f=body('activity'),body('full');check(a['activity']==f['activity'] and a['executionContent']==[],'Synthetic shared activity')
  check(len(f['executionContent'])==len(a['activity']),'Synthetic content event coverage')
  if p['seconds']==60:check('Synthetic assertion failed' not in json.dumps(p),'Future test result withheld')
  if p['seconds']==180:check('Synthetic future result' not in json.dumps(p),'Future repair result withheld')
 joined=0
 if args.numeric:
  numeric=json.loads(args.numeric.read_text(encoding='utf-8-sig'))
  for c in calls:
   if c['stage']!='evaluation':continue
   cell=f"G-evaluation|evaluation|normal|{c['anchor']}|{c['condition']}|gpt-6-sol"
   found=[r for r in numeric['calls'] if r['cell']==cell and r['task']==c['task'] and r['repeat']==c['repeat']]
   check(len(found)==1,'Numeric join cardinality')
   check(found[0]['prediction']==c['prediction'] and found[0]['trajectory']==c['trajectory'] and found[0]['repository']==c['repository'],'Numeric join values')
   joined+=1
  check(joined==96,'All G evaluation rows joined')
 print(json.dumps({'status':'pass','checks':count,'GInputs':72,'GPairs':36,'GCalls':144,'numericJoined':joined,
  'scope':'Published integrity and structural consistency; private original content is not independently verified.', 'newModelCalls':0}))
if __name__=='__main__':main()
