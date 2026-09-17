/** Diagnostic RPC boundary: matched policies, no source answers, no mutation. */
export function comparisonThreadParameters(method:string,params:Record<string,unknown>,base:string,evidence:string):Record<string,unknown>{
 if(!['thread/start','thread/fork'].includes(method))throw Error('TRIAL_INSTRUCTIONS_METHOD_INVALID');
 if(typeof params.developerInstructions!=='string'||!base||!evidence)throw Error('TRIAL_TRUSTED_INSTRUCTIONS_MISSING');
 if((method==='thread/fork'||params.baseInstructions!==undefined)&&params.baseInstructions!==base)throw Error('TRIAL_INSTRUCTIONS_MISMATCH');
 return {...params,baseInstructions:base,developerInstructions:params.developerInstructions+'\n'+evidence};
}

export function createComparisonForkRegistry(){
 const requests=new Map<string,string>(),forks=new Set<string>();
 return {
  record(request:string,sourceThreadId:string,forkId:unknown):void{
   if(typeof request!=='string'||!request||typeof sourceThreadId!=='string'||!sourceThreadId||
      typeof forkId!=='string'||!forkId||forkId===sourceThreadId)throw Error('TRIAL_FORK_INVALID');
   if(forks.has(forkId))throw Error('TRIAL_FORK_REUSED');
   if(requests.has(request))throw Error('TRIAL_REQUEST_REFORKED');
   requests.set(request,forkId);forks.add(forkId);
  },
  require(request:string):string{
   const forkId=requests.get(request);if(!forkId)throw Error('TRIAL_FORK_MISSING');return forkId;
  },
  snapshot:()=>Object.freeze([...requests].map(([request,forkId])=>Object.freeze({request,forkId}))),
 };
}

/** Completed-turn diagnostic accounting: an immutable base is not an ETA.
 * A process/cutoff pair may own one base; every request owns exactly one child. */
export function createCompletedTurnForkRegistry(allowReuse=false){
 const requests=new Map<string,{root:string;cutoff:string;owner:string;turn:string;child?:string}>();
 const childBindings=new Map<string,string>();
 const binding=(e:{root:string;cutoff:string;owner:string;turn:string})=>JSON.stringify([e.root,e.cutoff,e.owner,e.turn]);
 const bases=new Map<string,string>(),ids=new Set<string>();
 const records:Array<{request:string;role:'base'|'child'|'reused-child';forkId:string}>=[];
 return {
  begin(request:string,root:string,cutoff:string,owner:string,turn=cutoff){
   if([request,root,cutoff,owner,turn].some(x=>typeof x!=='string'||!x)||requests.has(request))throw Error('TRIAL_REQUEST_INVALID');
   requests.set(request,{root,cutoff,owner,turn});
  },
  record(request:string,params:Record<string,unknown>,forkId:unknown){
   const entry=requests.get(request);
   if(!entry||entry.child||typeof forkId!=='string'||!forkId||forkId===entry.root||ids.has(forkId)||params.lastTurnId!==entry.cutoff)throw Error('TRIAL_FORK_INVALID');
   const key=JSON.stringify([entry.root,entry.cutoff,entry.owner]),base=bases.get(key);
   const role=params.path===undefined?'child':'base';
   if(role==='base'){
    if(base||params.threadId!==entry.root||typeof params.path!=='string'||!params.path)throw Error('TRIAL_BASE_INVALID');
    bases.set(key,forkId);
   }else{
    if(!base||params.threadId!==base||forkId===base)throw Error('TRIAL_CHILD_PARENT_INVALID');
    entry.child=forkId;
    childBindings.set(forkId,binding(entry));
   }
   ids.add(forkId);records.push({request,role,forkId});
  },
  reuse(request:string,forkId:string){
   const entry=requests.get(request);
   if(!allowReuse||!entry||entry.child||childBindings.get(forkId)!==binding(entry))throw Error('TRIAL_CHILD_REUSE_INVALID');
   entry.child=forkId;records.push({request,role:'reused-child',forkId});
  },
  require(request:string){const child=requests.get(request)?.child;if(!child)throw Error('TRIAL_FORK_MISSING');return child;},
  snapshot:()=>Object.freeze(records.map(row=>Object.freeze({...row}))),
 };
}
