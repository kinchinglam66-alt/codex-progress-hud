import {test} from 'node:test';import assert from 'node:assert/strict';import {buildPair,canonicalLedger,sha} from './canonical.mjs';
test('fixed cutoff withholds future results but retains pending command and same activity',()=>{
 const ledger={events:[{id:1,phase:'started',atMs:1000,tool:'container_command',command:'cat src/x'},{id:1,phase:'result_arrived',atMs:61001,tool:'container_command',result:{stdout:'future'}},{id:2,phase:'started',atMs:2000,tool:'container_command',command:'cat src/x'}]};
 const p=buildPair({initial:'task',goal:'goal',timeBasis:'basis',ledger,zero:0,seconds:60});const body=x=>JSON.parse(x.messages[1].text.split('\n').slice(1).join('\n'));
 assert.deepEqual(body(p.activity).activity,body(p.full).activity);assert.equal(body(p.activity).executionContent.length,0);assert.equal(body(p.full).executionContent.length,2);assert.ok(!JSON.stringify(p.full).includes('future'));assert.equal(p.audit.duplicateIdentities,0);
});
test('duplicate wrapper ignored by identity; same output from different ids retained; readable snapshot governs cutoff',()=>{
 const commands=[{callId:'a',command:'echo x'},{callId:'b',command:'echo x'}],out={stdout:'x',stderr:'',exitCode:0,executionStarted:true,outputComplete:true},content=[{type:'inputText',text:JSON.stringify(out)}];
 const ns=commands.map((c,i)=>({ordinal:i+1,payload:{type:'item_completed',item:{type:'DynamicToolCall',id:c.callId,arguments:{command:c.command},content_items:content}}}));
 ns.push({payload:{type:'function_call_output',output:JSON.stringify(content)}});const bytes=Buffer.from(ns.map(JSON.stringify).join('\n')+'\n');
 const audit=commands.flatMap((c,i)=>[{type:'server-request',sequence:i*2,atMs:10+i,frame:{id:i,method:'item/tool/call',params:{callId:c.callId,tool:'hud_benchmark_container',arguments:{command:c.command}}}},{type:'server-result',sequence:i*2+1,requestId:i,atMs:20+i,result:{contentItems:content}}]);
 const args={sourceBytes:bytes,snapshots:[{atMs:1000,source:{ready:true,etaReady:true,completeBytes:bytes.length,sourceSha256:sha(bytes)}}],audit,commands,records:commands.map(c=>({...c,commandSha256:sha(c.command),executionStarted:true})),zero:0};args.commands=args.commands.map(c=>({...c,atMs:15}));
 const ledger=canonicalLedger(args);assert.equal(ledger.mapping.length,2);assert.equal(ledger.events.filter(e=>e.phase==='result_arrived').length,2);assert.ok(ledger.mapping.every(m=>m.visibleAtMs===1000));
 args.snapshots[0].source.sourceSha256='bad';assert.throws(()=>canonicalLedger(args),/PREFIX_HASH/);
});
test('rejected arguments retain visible non-execution error and never become an executed command',()=>{
 const args={command:'echo x',timeout:100},out={kind:'argument-error',executionStarted:false,outputComplete:true,errorCode:'BROKER_ARGUMENTS',message:'Command was not executed.'},content=[{type:'inputText',text:JSON.stringify(out)}];
 const n={ordinal:1,payload:{type:'item_completed',item:{type:'DynamicToolCall',id:'rejected',arguments:args,content_items:content}}},bytes=Buffer.from(JSON.stringify(n)+'\n');
 const ledger=canonicalLedger({sourceBytes:bytes,snapshots:[{atMs:30,source:{ready:true,etaReady:true,completeBytes:bytes.length,sourceSha256:sha(bytes)}}],audit:[{type:'server-request',sequence:1,atMs:10,frame:{id:1,method:'item/tool/call',params:{callId:'rejected',tool:'hud_benchmark_container',arguments:args}}},{type:'server-result',sequence:2,atMs:20,requestId:1,result:{contentItems:content}}],commands:[],records:[{callId:'rejected',executionStarted:false,argumentsSha256:sha(args)}],zero:0});
 assert.equal(ledger.mapping[0].executionStarted,false);assert.deepEqual(ledger.events[0].arguments,args);assert.equal(ledger.events[1].result.executionStarted,false);assert.ok(!Object.hasOwn(ledger.events[1].result,'stdout'));
});
