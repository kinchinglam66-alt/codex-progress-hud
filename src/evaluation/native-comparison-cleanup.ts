import {performance} from 'node:perf_hooks';
/** One failed owner never suppresses the remaining independent close attempts. */
export async function closeComparisonOwners(owners:readonly {name:string;close:()=>Promise<void>}[]){
 const failed:string[]=[],durationMs:Record<string,number>={};
 for(const owner of owners){
  const started=performance.now();
  try{await owner.close();}catch{failed.push(owner.name);}
  finally{durationMs[owner.name]=performance.now()-started;}
 }
 return {failed,durationMs};
}
