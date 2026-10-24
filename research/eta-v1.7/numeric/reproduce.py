"""Offline arithmetic reproduction. Python 3.10+, standard library only; no network."""
import json
import math
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent

def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None

def pearson(xs, ys):
    if len(xs) < 3 or len(xs) != len(ys):
        return None
    mx, my = mean(xs), mean(ys)
    xx = sum((x-mx)**2 for x in xs)
    yy = sum((y-my)**2 for y in ys)
    return sum((x-mx)*(y-my) for x,y in zip(xs,ys))/math.sqrt(xx*yy) if xx and yy else None

def bootstrap(rows):
    """Task-weighted mean after sampling repository clusters with replacement."""
    groups = defaultdict(list)
    for row in rows:
        groups[row['repository']].append(row['value'])
    groups = list(groups.values())
    assert groups
    seed, draws = 20261024, []
    for _ in range(10000):
        total, n = 0.0, 0
        for _ in groups:
            seed = (1664525 * seed + 1013904223) & 0xffffffff
            group = groups[math.floor(seed/4294967296 * len(groups))]
            for value in group:
                total += value
                n += 1
        draws.append(total/n)
    draws.sort()
    return {'mean':mean([r['value'] for r in rows]),
            'lower':draws[math.floor(.025*(len(draws)-1))],
            'upper':draws[math.ceil(.975*(len(draws)-1))],
            'tasks':len(rows), 'repositories':len(groups)}

def task_metrics(rows):
    groups = defaultdict(list)
    for row in rows:
        groups[row['task']].append(row)
    out = []
    for task, rs in groups.items():
        truth = rs[0]['truth']
        assert truth > 0 and all(r['truth']==truth and r['repository']==rs[0]['repository'] for r in rs)
        assert len({r['repeat'] for r in rs}) == len(rs)
        errors = [r['prediction']-truth for r in rs]
        out.append({'task':task, 'repository':rs[0]['repository'], 'truth':truth,
                    'predictions':{r['repeat']:r['prediction'] for r in rs},
                    'meanPrediction':mean([r['prediction'] for r in rs]),
                    'MAE':mean([abs(e) for e in errors]), 'signedBias':mean(errors),
                    'MARE':mean([abs(e)/truth for e in errors]) if truth>=60 else None,
                    'positiveContribution':mean([max(e,0) for e in errors]),
                    'negativeMagnitude':mean([max(-e,0) for e in errors])})
    return out

def paired(a,b):
    other = {r['task']:r for r in b}
    out = []
    for x in a:
        y = other.get(x['task'])
        if y is None:
            continue
        assert x['truth'] == y['truth'] and x['repository']==y['repository']
        repeats = [i for i in x['predictions'] if i in y['predictions']]
        if not repeats:
            continue
        baseline = mean([abs(x['predictions'][i]-x['truth']) for i in repeats])
        candidate = mean([abs(y['predictions'][i]-y['truth']) for i in repeats])
        out.append({'task':x['task'],'repository':x['repository'],'baseline':baseline,
                    'candidate':candidate,'value':candidate-baseline})
    return out

def self_test():
    rows=[{'task':'one','repository':'r1','truth':100,'prediction':50,'repeat':1},
          {'task':'one','repository':'r1','truth':100,'prediction':150,'repeat':2},
          {'task':'two','repository':'r2','truth':50,'prediction':70,'repeat':1}]
    ts=task_metrics(rows)
    assert ts[0]['MAE']==50 and ts[0]['signedBias']==0 # not abs(mean forecast error)
    assert ts[1]['MARE'] is None and mean([t['MAE'] for t in ts])==35
    assert pearson([1,2,3],[2,4,6])==1 and pearson([1,1,1],[1,2,3]) is None
    assert all(p['value']==0 for p in paired(ts,ts))
    assert bootstrap([{'repository':'r','value':2}])['lower']==2

def run():
    self_test()
    data=json.loads((HERE/'numeric-data.json').read_text(encoding='utf-8'))
    expected=json.loads((HERE/'expected-results.json').read_text(encoding='utf-8'))
    groups=defaultdict(list)
    for row in data['calls']:
        if row['eligible']:
            assert row['prediction'] is not None and row['prediction']>=0 and row['truth']>0
            groups[row['cell']].append(row)
    tasks={k:task_metrics(rs) for k,rs in groups.items()}
    cells={}
    for key,ts in tasks.items():
        cells[key]={'tasks':len(ts), 'MAREtasks':sum(t['MARE'] is not None for t in ts),
                    **{m:mean([t[m] for t in ts]) for m in ['MAE','MARE','signedBias','positiveContribution','negativeMagnitude']},
                    'pearson':pearson([t['meanPrediction'] for t in ts],[t['truth'] for t in ts])}
    contrasts, pair_rows={},{}
    for spec in data['contrasts']:
        rs=paired(tasks[spec['a']],tasks[spec['b']])
        pair_rows[spec['id']]=rs
        contrasts[spec['id']]={**bootstrap(rs), 'baselineMean':mean([r['baseline'] for r in rs]),
                               'candidateMean':mean([r['candidate'] for r in rs])}
    interactions={}
    for spec in data['interactions']:
        before,after={r['task']:r for r in pair_rows[spec['before']]},pair_rows[spec['after']]
        # Retain the archived later/candidate-cluster encounter order. The fixed
        # seed reproduces exact finite-draw limits only with the same ordering.
        rs=[{'task':r['task'],'repository':r['repository'],'value':r['value']-before[r['task']]['value']}
            for r in after if r['task'] in before]
        interactions[spec['id']]=bootstrap(rs)
    fixed={}
    for spec in data['fixedSupport']:
        ts=[t for t in tasks[spec['cell']] if t['task'] in spec['taskIds']]
        assert len(ts)==len(spec['taskIds'])
        fixed[spec['id']]={'tasks':len(ts),'MAE':mean([t['MAE'] for t in ts]),'MARE':mean([t['MARE'] for t in ts])}
    results={'cells':cells,'contrasts':contrasts,'interactions':interactions,'fixedSupport':fixed}
    checks=[]
    for section,records in expected.items():
        for key,fields in records.items():
            for metric,want in fields.items():
                got=results[section][key][metric]
                assert got==want or (got is not None and want is not None and abs(got-want)<1e-8), (section,key,metric,got,want)
                checks.append('/'.join([section,key,metric]))
    report={'status':'PASS','numericComparisons':len(checks),'selfTests':'PASS',
            'recordedRows':len(data['calls']),'eligibleRows':sum(r['eligible'] for r in data['calls']),
            'units':'seconds, except MARE ratios and correlations','seed':20261024,'bootstrapDraws':10000,
            'modelCalls':0,'networkCalls':0,'newCalibrationFits':0,
            'scope':'Numerical reproduction on supplied derived data, not independent recovery of transcripts or experimental validity.',
            'results':results}
    (HERE/'verification.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='results'}))

if __name__=='__main__':
    run()
