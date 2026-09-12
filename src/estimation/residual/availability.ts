interface Closeable {close():Promise<void>}
/** Bounds waiting, not filesystem I/O: a late owner is closed, never published. */
export function openResearchBounded<T extends Closeable>(open:()=>Promise<T>,waitMs=250):Promise<T|undefined>{
  return new Promise(resolve=>{
    let settled=false;
    const timer=setTimeout(()=>{settled=true;resolve(undefined);},waitMs);
    Promise.resolve().then(open).then(owner=>{
      if(settled){void Promise.resolve().then(()=>owner.close()).catch(()=>undefined);return;}
      settled=true;clearTimeout(timer);resolve(owner);
    },()=>{if(!settled){settled=true;clearTimeout(timer);resolve(undefined);}});
  });
}
export async function closeResearchBounded(owner:Closeable|undefined,waitMs=250):Promise<void>{
  if(!owner)return;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([Promise.resolve().then(()=>owner.close()).catch(()=>undefined),
    new Promise<void>(resolve=>{timer=setTimeout(resolve,waitMs);})]);}
  finally{clearTimeout(timer);}
}
