import {describe,it,expect} from 'vitest';
import {createObservationCoverage,projectWireMetrics} from '../../src/estimation/observation-wire.js';
import {observerInputSchema,type ObserverInput} from '../../src/estimation/observer-contract.js';
const text='Task and exact evidence. '.repeat(100);
const input:ObserverInput={goalSummary:null,activeSeconds:5,runtime:'running',truncated:false,messages:[{kind:'user',text,truncated:false,event:{ordinal:0,kind:'user',atMs:100}}]};
const record={ordinal:0,text:JSON.stringify({kind:'user',atMs:100,text})};
describe('lossless observation wire projection',()=>{
 it('binds coverage digest to ordered content as well as ordinal',()=>{
  const a=createObservationCoverage(),b=createObservationCoverage();a.add(record);
  const changed=structuredClone(input);changed.messages[0]!.text+='different content';
  b.add({ordinal:0,text:JSON.stringify({kind:'user',atMs:100,text:changed.messages[0]!.text})});
  expect(a.project(input).metrics.coverageDigest).not.toBe(b.project(changed).metrics.coverageDigest);
 });
 it('keeps the original valid packet and metadata, replaces only exact covered text',()=>{
  const c=createObservationCoverage();c.add(record);const result=c.project(input);
  expect(observerInputSchema.parse(input)).toEqual(input);
  expect(input.messages[0]!.text).toBe(text);
  expect(result.observation.messages[0]).toEqual({kind:'user',truncated:false,event:input.messages[0]!.event,sourceReference:{ordinal:0}});
  expect(result.metrics.sentObservationBytes).toBeLessThan(result.metrics.originalObservationBytes);
  expect(result.metrics.referencedMessages).toBe(1);
 });
 it.each(['time','kind','text','ordinal','truncated','missing_event'] as const)('keeps unproven %s content',change=>{
  const c=createObservationCoverage();c.add(record);const copy=structuredClone(input),m=copy.messages[0]!;
  if(change==='time')m.event!.atMs++;
  if(change==='kind')m.event!.kind='assistant';
  if(change==='text')m.text+='new';
  if(change==='ordinal')m.event!.ordinal++;
  if(change==='truncated')m.truncated=true;
  if(change==='missing_event')delete m.event;
  expect(c.project(copy).metrics.referencedMessages).toBe(0);
 });
 it('does not share coverage across sessions or after compaction invalidation',()=>{
  const a=createObservationCoverage(),b=createObservationCoverage();a.add(record);
  expect(b.project(input).metrics.referencedMessages).toBe(0);a.clear();expect(a.project(input).metrics.referencedMessages).toBe(0);
 });
 it('keeps multimodal and opaque records intact',()=>{
  const c=createObservationCoverage();c.add({...record,content:[{type:'input_image',image_url:'data:image/png;base64,YQ=='}]});
  c.add({ordinal:0,text:'opaque source'});expect(c.project(input).metrics.referencedMessages).toBe(0);
 });
 it('projects only bounded numeric diagnostics and digest, never prompt text',()=>{
  const metrics=createObservationCoverage().project(input).metrics;
  expect(projectWireMetrics({...metrics,text:'private'})).toEqual(metrics);
  expect(projectWireMetrics({...metrics,sentObservationBytes:-1})).toBeUndefined();
 });
});
