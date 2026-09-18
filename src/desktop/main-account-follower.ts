interface Options {enabled():boolean;currentFingerprint():string|null;readFingerprint(signal:AbortSignal):Promise<string>;refresh(signal:AbortSignal):Promise<boolean>}
/** Local identity polling only. Refresh owns remote checks and authorization;
 * one operation at a time, with backoff after any unsuccessful replacement. */
export function createMainAccountFollower(options:Options){
 const lifetime=new AbortController();let started=false;
 let timer:ReturnType<typeof setTimeout>|undefined,pending:Promise<void>|undefined;
 const schedule=(delay:number)=>{
  if(lifetime.signal.aborted)return;
  timer=setTimeout(()=>{timer=undefined;pending=tick();},delay);timer.unref?.();
 };
 async function tick(){
  let delay=2000;
  try{
   if(lifetime.signal.aborted||!options.enabled())return;
   let fingerprint:string|null=null;
   try{fingerprint=await options.readFingerprint(lifetime.signal);}catch{/* Unavailable identity must retire the old owner too. */}
   if(lifetime.signal.aborted||!options.enabled())return;
   if(fingerprint===null||fingerprint!==options.currentFingerprint()){
    if(!await options.refresh(lifetime.signal))delay=30000;
   }
  }catch{delay=30000;}
  finally{pending=undefined;schedule(delay);}
 }
 return {start(){if(started||lifetime.signal.aborted)return;started=true;schedule(2000);},
  async close(){lifetime.abort();clearTimeout(timer);timer=undefined;await pending;}};
}
