import {expect,it} from 'vitest';
import {assembleContext} from '../../src/observer/context-assembler.js';
import {observerInputSchema} from '../../src/estimation/observer-contract.js';
import {packObserverInput} from '../../src/estimation/observer-input.js';

function input(){return assembleContext([{id:'u',turnId:'t',atMs:0,kind:'user',text:'wait 100 seconds'},
  {id:'a',turnId:'t',atMs:1000,kind:'tool_start',actionId:'a',text:'sleep 100'}],
  {summary:null,summaryThroughSequence:0,sequence:2,activeSeconds:10,activeTimeKnown:false,
    historyComplete:true,nowMs:10000,previousEstimate:null});}

it('retains bounded observation metadata through the inference packet boundary',()=>{
  const value=input();expect(observerInputSchema.safeParse(value).success).toBe(true);
  expect(JSON.parse(packObserverInput(value)).observation).toEqual(value.observation);
});
it('rejects impossible metadata and undeclared fields',()=>{
  const value=input();
  for(const observation of [{...value.observation,sequence:-1},{...value.observation,sequence:1.5},
    {...value.observation,summaryThroughSequence:3},{...value.observation,currentAction:{text:'x',elapsedSeconds:-1}},
    {...value.observation,previousEstimate:{remainingSeconds:10,errorPercent:50,observedActiveSeconds:20}},
    {...value.observation,rawTranscript:'not allowed'}]){
    expect(observerInputSchema.safeParse({...value,observation}).success).toBe(false);
  }
});
it('filters credentials in action metadata as well as messages',()=>{
  const value=input();value.observation.currentAction!.text='Authorization: Bearer abcdefghijklmnopqrstuvwxyz';
  expect(packObserverInput(value)).not.toContain('abcdefghijklmnopqrstuvwxyz');
});
