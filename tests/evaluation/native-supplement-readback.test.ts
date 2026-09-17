import {describe,it,expect} from 'vitest';
import {compareSupplementReadback,submittedSupplementItems} from '../../src/evaluation/native-supplement-readback.js';
const frame=(ordinal:number,text:string)=>JSON.stringify({observedRecord:{ordinal,part:0,final:true,text}});
const message=(text:string)=>({type:'message',role:'user',content:[{type:'input_text',text}]});
const rollout=(items:unknown[])=>items.map(payload=>({type:'response_item',payload}));
describe('native supplement readback',()=>{
 it('accumulates initial submitted source and later injected delta without duplicating observation-only turns',()=>{
  const a=frame(0,'initial'),b=frame(1,'delta');
  const initial=submittedSupplementItems([{type:'text',text:a},{type:'text',text:JSON.stringify({currentObservation:{}})}]);
  const observationOnly=submittedSupplementItems([{type:'text',text:JSON.stringify({currentObservation:{activeSeconds:20}})}]);
  const accumulated=[...initial,message(b),...observationOnly];
  expect(compareSupplementReadback(accumulated,rollout([...initial,message(b),...observationOnly]))).toMatchObject({sentFrames:2,readFrames:2,exact:true});
  expect(compareSupplementReadback(accumulated,rollout([...initial,...initial,message(b)]))).toMatchObject({exact:false});
 });
 it('compares submitted user-input frames with actual owned rollout without treating observation as source',()=>{
  const a=frame(0,'source'),b=frame(1,'later');
  const items=submittedSupplementItems([{type:'text',text:a,text_elements:[]},{type:'text',text:b,text_elements:[]},
   {type:'text',text:JSON.stringify({currentObservation:{goalSummary:'not source'}}),text_elements:[]}]);
  expect(compareSupplementReadback(items,rollout([message(a),message(b)]))).toMatchObject({sentFrames:2,readFrames:2,exact:true});
  expect(compareSupplementReadback(items,rollout([message(b)]))).toMatchObject({exact:false});
 });
 it('matches exact ordered source frames, not the presence of an old marker somewhere in history',()=>{
  const a=message(frame(0,'request')),b=message(frame(1,'GAMMA'));
  const older={type:'message',role:'assistant',content:[{type:'output_text',text:'BETA'}]};
  expect(compareSupplementReadback([a,b],rollout([older,a,b]))).toMatchObject({sentFrames:2,readFrames:2,exact:true});
  expect(compareSupplementReadback([a,b],rollout([older,a]))).toMatchObject({sentFrames:2,readFrames:1,exact:false});
  expect(compareSupplementReadback([a,b],rollout([b,a]))).toMatchObject({exact:false});
 });
 it('does not report success for an empty or duplicated supplement and retains no source text',()=>{
  const a=message(frame(0,'private-synthetic-value'));
  expect(compareSupplementReadback([],[]).exact).toBe(false);
  expect(compareSupplementReadback([a],rollout([a,a])).exact).toBe(false);
  const result=compareSupplementReadback([a],rollout([a]));
  expect(JSON.stringify(result)).not.toContain('private-synthetic-value');
  expect(result.sentDigest).toMatch(/^[a-f0-9]{64}$/);
 });
});
