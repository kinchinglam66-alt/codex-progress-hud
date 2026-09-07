import {open} from 'node:fs/promises';
import {scorePilotGoal} from '../../dist/evaluation/pilot-score.js';

async function bounded(path,limit){
  const file=await open(path,'r');
  try{
    const info=await file.stat();if(!info.isFile() || info.size>limit)throw Error();
    const buffer=Buffer.alloc(limit+1),{bytesRead}=await file.read(buffer,0,buffer.length,0);
    if(bytesRead>limit)throw Error();return buffer.subarray(0,bytesRead).toString('utf8');
  }finally{await file.close();}
}
try{
  if(process.argv.length!==4)throw Error();
  const records=(await bounded(process.argv[2],12*1024*1024)).trim().split('\n').map(line=>JSON.parse(line));
  const label=JSON.parse(await bounded(process.argv[3],16384));
  const trailer=records.at(-1);
  const recordingComplete=trailer?.kind==='journal_summary' && trailer.failed===false && trailer.dropped===0 && trailer.pendingRequests===0;
  console.log(JSON.stringify({recordingComplete,warning:recordingComplete?null:'Incomplete recording: audit gaps before interpreting accuracy.',
    score:scorePilotGoal(records,label)},null,2));
}catch{
  console.error('PILOT_SCORE_UNAVAILABLE: provide a bounded pilot JSONL file and a separate user-confirmed label JSON.');
  process.exitCode=1;
}
