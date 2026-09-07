import {expect,it} from 'vitest';
import {createObserverDiagnosticRunner} from '../../src/estimation/observer-diagnostics.js';
import {createObserverOutputParser} from '../../src/estimation/codex-output.js';

it('reports exit and parser failure with network categories but no raw content',async()=>{
 const reports:unknown[]=[];
 const runner=createObserverDiagnosticRunner(value=>reports.push(value));
 const parser=createObserverOutputParser();
 const result=await runner.run({executable:process.execPath,cwd:process.cwd(),env:process.env,input:'',
  args:['-e',`process.stderr.write('HTTP 403 token=SECRET email=private@example.com');process.exitCode=7;`],onStdout:parser.push},new AbortController().signal);
 expect(result.exitCode).toBe(7);
 expect(reports).toHaveLength(1);
 expect(reports[0]).toMatchObject({reason:'exited',exitCode:7,closed:true,parserError:'protocol',errorCategories:['http_403']});
 expect(JSON.stringify(reports)).not.toMatch(/SECRET|private@example|token=/);
});

it('continues past invalid prediction to collect usage without leaking the answer',async()=>{
 const reports:unknown[]=[];const runner=createObserverDiagnosticRunner(value=>reports.push(value));
 const parser=createObserverOutputParser();
 const stream=[{type:'turn.started'},{type:'item.completed',item:{id:'x',type:'agent_message',text:'secret invalid answer'}},
  {type:'turn.completed',usage:{input_tokens:10,output_tokens:2,cached_input_tokens:0}}].map(x=>JSON.stringify(x)).join('\n')+'\n';
 const result=await runner.run({executable:process.execPath,cwd:process.cwd(),env:process.env,input:'',args:['-e',`process.stdout.write(${JSON.stringify(stream)})`],onStdout:parser.push},new AbortController().signal);
 expect(result.reason).toBe('exited');
 expect(reports[0]).toMatchObject({closed:true,parserError:'invalid_prediction'});
 expect(parser.end().usage).toMatchObject({inputTokens:10,outputTokens:2});
 expect(JSON.stringify(reports)).not.toContain('secret');
 expect(runner.status().active).toBe(false);
});

it('still cancels forbidden tool output immediately and confirms process closure',async()=>{
 const reports:unknown[]=[];const runner=createObserverDiagnosticRunner(value=>reports.push(value));
 const parser=createObserverOutputParser();
 const stream=JSON.stringify({type:'item.completed',item:{id:'x',type:'command_execution',command:'secret'}})+'\n';
 try{
  const result=await runner.run({executable:process.execPath,cwd:process.cwd(),env:process.env,input:'',
   args:['-e',`process.stdout.write(${JSON.stringify(stream)});setInterval(()=>{},1000)`],onStdout:parser.push},new AbortController().signal);
  expect(result.reason).toBe('protocol_error');expect(reports[0]).toMatchObject({closed:true,parserError:'unexpected_tool'});
  expect(JSON.stringify(reports)).not.toContain('secret');expect(runner.status().active).toBe(false);
 }finally{runner.disable();}
});

it('ignores diagnostic sink errors without changing process outcome',async()=>{
 const runner=createObserverDiagnosticRunner(()=>{throw Error('sink');});
 const result=await runner.run({executable:process.execPath,cwd:process.cwd(),env:process.env,input:'',args:['-e','process.exitCode=4']},new AbortController().signal);
 expect(result.exitCode).toBe(4);
});

it('classifies CLI error events without exposing their text',async()=>{
 const reports:unknown[]=[];const runner=createObserverDiagnosticRunner(value=>reports.push(value));
 const output=JSON.stringify({type:'error',message:'HTTP 429 token=PRIVATE'})+'\n';
 await runner.run({executable:process.execPath,cwd:process.cwd(),env:process.env,input:'',args:['-e',`process.stdout.write(${JSON.stringify(output)})`]},new AbortController().signal);
 expect(reports[0]).toMatchObject({errorCategories:['http_429']});
 expect(JSON.stringify(reports)).not.toContain('PRIVATE');
});
