import readline from 'node:readline';
const mode=process.argv[2];
const reader=readline.createInterface({input:process.stdin});
let initialized=false;
reader.on('line',line=>{
  const request=JSON.parse(line);
  if(mode==='timeout') return;
  if(request.method==='initialize') {
    process.stdout.write(JSON.stringify({id:0,result:{}})+'\n');
  } else if(request.method==='initialized') {initialized=true;}
  else if(request.method==='thread/read' && initialized && request.params.includeTurns===false) {
    if(mode==='invalid') {process.stdout.write('not json\n');return;}
    if(mode==='flood') {process.stdout.write('x'.repeat(600000));return;}
    const id=mode==='mismatch'?'other':request.params.threadId;
    process.stdout.write(JSON.stringify({id:1,result:{thread:{id,name:'Host title',preview:'must be discarded'}}})+'\n');
  } else { process.exitCode=2; process.stdin.destroy(); }
});
