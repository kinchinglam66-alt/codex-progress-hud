import {it,expect} from 'vitest';
import {TASK_OBJECTIVE_TARGET as predictionTarget} from '../../src/core/task-objective.js';
import {ETA_TIME_BASIS as basis} from '../../src/core/eta-time-basis.js';
import {scoreTaskObjectivePrediction as score} from '../../src/evaluation/task-objective-score.js';
import {scoreWallClockPrediction} from '../../src/evaluation/wall-clock-score.js';
const timeline={basis,threadId:'thread',turnId:'turn',startMs:0,endMs:100000,outcome:'completed',clockVerified:true,
 boundaryEvidenceRefs:['native:start','native:end'],segments:[{startMs:0,endMs:100000,kind:'system_or_running',evidenceRefs:['native:all']}]};
const prediction={basis,predictionTarget,targetId:'objective',predictionId:'p',threadId:'thread',turnId:'turn',anchorMs:0,deliveredAtMs:1000,
 remainingSeconds:100,displayedRemainingSeconds:99,deliveryEvidenceRefs:['display:1']};
const certificate={predictionTarget,threadId:'thread',turnId:'turn',targetId:'objective',controller:'independent_controller',
 verdict:'achieved',evidenceRefs:['tests:100'],achievedAtMs:100000};
it('requires independent objective achievement, not native normal end alone',()=>{
 expect(score(timeline,prediction,{...certificate,verdict:'unknown',evidenceRefs:[],achievedAtMs:null}).primaryEligible).toBe(false);
 expect(score(timeline,prediction,certificate).primaryEligible).toBe(false);
 expect(score(timeline,prediction,certificate).reasons).toContain('objective_evidence_not_independently_verified');
});
it('rejects wrong target, turn, achievement time and missing evidence',()=>{
 for(const patch of [{targetId:'other'},{turnId:'other'},{achievedAtMs:90000},{evidenceRefs:[]}])
 expect(score(timeline,prediction,{...certificate,...patch}).primaryEligible).toBe(false);
});
it('interrupted partial work is not a completed accuracy sample',()=>{
 expect(score({...timeline,outcome:'interrupted'},prediction,{...certificate,verdict:'not_achieved'}).primaryEligible).toBe(false);
});
it('old final-reply scorer cannot silently consume marked objective predictions',()=>{
 expect(()=>scoreWallClockPrediction(timeline,prediction)).toThrow();
 expect(()=>score(timeline,{...prediction,predictionTarget:undefined},certificate)).toThrow();
});
