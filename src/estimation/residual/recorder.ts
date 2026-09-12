import {createHash,createHmac,randomBytes} from 'node:crypto';
import {mkdir,lstat,realpath,writeFile,link,unlink,readFile,readdir,open,type FileHandle} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {parseResearchRecord,type ResearchRecord} from './contract.js';

const ROW=16*1024,SEGMENT=10*1024*1024,TOTAL=100*1024*1024;
const pattern=/^segment-([a-f0-9]{32})-(\d{6})\.jsonl$/u;
async function safeDirectory(directory:string):Promise<string>{
  const root=resolve(directory);await mkdir(root,{recursive:true});
  const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink())throw Error('RESEARCH_DIRECTORY_UNSAFE');
  return realpath(root);
}
async function regular(path:string,max:number):Promise<void>{
  const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)throw Error('RESEARCH_FILE_UNSAFE');
}
async function identitySecret(root:string):Promise<string>{
  const path=resolve(root,'identity.json');
  try{await regular(path,256);}catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    const temporary=resolve(root,`identity-${randomBytes(16).toString('hex')}.tmp`);
    await writeFile(temporary,JSON.stringify({schemaVersion:1,key:randomBytes(32).toString('hex')}),{flag:'wx',mode:0o600});
    try{await link(temporary,path);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    finally{await unlink(temporary);}
  }
  await regular(path,256);const value=JSON.parse(await readFile(path,'utf8')) as Record<string,unknown>;
  if(Object.keys(value).length!==2||value.schemaVersion!==1||typeof value.key!=='string'||!/^[a-f0-9]{64}$/u.test(value.key))throw Error('RESEARCH_IDENTITY_INVALID');
  return value.key;
}

/** Metadata only. A bad/partial recording run is never eligible for training. */
export async function createResidualRecorder(directory:string){
  const root=await safeDirectory(directory),key=await identitySecret(root),stream=randomBytes(16).toString('hex');
  let tail=Promise.resolve(),closed:Promise<void>|undefined,handle:FileHandle|undefined;
  let index=0,bytes=0,written=0,dropped=0,pending=0,failed=false;
  let digest=createHash('sha256');
  async function rotate(){
    const files=[];
    for(const name of await readdir(root))if(pattern.test(name)){
      const path=resolve(root,name);await regular(path,SEGMENT+ROW);
      const stat=await lstat(path);files.push({path,size:stat.size,time:stat.mtimeMs});
    }
    let total=files.reduce((n,f)=>n+f.size,0);
    for(const file of files.sort((a,b)=>a.time-b.time)){
      if(total<=TOTAL)break;
      // Never remove this writer's open segment or a file without a closed footer.
      if(file.path===resolve(root,`segment-${stream}-${String(index).padStart(6,'0')}.jsonl`)&&handle)continue;
      const text=await readFile(file.path,'utf8'),last=text.trimEnd().split('\n').at(-1);
      let footer:Record<string,unknown>;try{footer=JSON.parse(last??'');}catch{continue;}
      if(footer.kind!=='segment_footer')continue;
      if(dirname(file.path)!==root)throw Error('RESEARCH_ROTATION_OUTSIDE_ROOT');
      await regular(file.path,SEGMENT+ROW);await unlink(file.path);total-=file.size;
    }
    if(total>TOTAL)throw Error('RESEARCH_STORAGE_FULL');
  }
  async function begin(){
    if(handle)return;
    if(index>999999)throw Error('RESEARCH_SEGMENTS_EXHAUSTED');
    handle=await open(resolve(root,`segment-${stream}-${String(index).padStart(6,'0')}.jsonl`),'wx',0o600);
    const header=JSON.stringify({kind:'segment_header',schemaVersion:1,stream,index})+'\n';
    await handle.writeFile(header);bytes=Buffer.byteLength(header);digest=createHash('sha256');
  }
  async function finish(final:boolean){
    await begin();const file=handle!;handle=undefined;
    try{await file.writeFile(JSON.stringify({kind:'segment_footer',stream,index,final,dropped,digest:digest.digest('hex')})+'\n');}
    finally{await file.close();}
    index++;bytes=0;await rotate();
  }
  return {
    identify(host:string,conversation:string,turn:string){
      const hash=(parts:string[])=>createHmac('sha256',key).update(JSON.stringify(parts)).digest('hex');
      return {groupId:hash(['group',host,conversation]),turnId:hash(['turn',host,conversation,turn])};
    },
    record(value:ResearchRecord):void{
      if(closed||failed||pending>=128){dropped++;return;}
      let line:string;try{line=JSON.stringify(parseResearchRecord(value))+'\n';}catch{dropped++;return;}
      const size=Buffer.byteLength(line);if(size>ROW){dropped++;return;}
      pending++;
      tail=tail.then(async()=>{
        if(failed){dropped++;return;}
        await begin();if(bytes+size+ROW>SEGMENT)await finish(false);
        await begin();await handle!.writeFile(line);digest.update(line);bytes+=size;written++;
      }).catch(()=>{failed=true;dropped++;}).finally(()=>{pending--;});
    },
    status:()=>({written,dropped,failed}),
    close():Promise<void>{
      return closed??=tail.then(async()=>{if(!failed)await finish(true);}).catch(()=>{failed=true;})
        .finally(async()=>{const file=handle;handle=undefined;try{await file?.close();}catch{failed=true;}});
    },
  };
}

/** Read only complete, digest-checked contiguous writer runs; return loss counts. */
export async function readResidualSegments(directory:string):Promise<{records:ResearchRecord[];excluded:Record<string,number>}>{
  const root=await realpath(directory),runs=new Map<string,string[]>(),records:ResearchRecord[]=[],excluded:Record<string,number>={};
  for(const name of await readdir(root)){const match=pattern.exec(name);if(match){const list=runs.get(match[1]!)??[];list.push(name);runs.set(match[1]!,list);}}
  for(const [stream,names] of runs){
    const batch:ResearchRecord[]=[];let valid=true,finished=false;
    for(const [index,name] of names.sort().entries()){
      try{
        const path=resolve(root,name);await regular(path,SEGMENT+ROW);
        const lines=(await readFile(path,'utf8')).split('\n');if(lines.pop()!=='')throw Error('partial');
        const header=JSON.parse(lines.shift()??''),footer=JSON.parse(lines.pop()??'');
        if(header.kind!=='segment_header'||header.schemaVersion!==1||header.stream!==stream||header.index!==index||
          footer.kind!=='segment_footer'||footer.stream!==stream||footer.index!==index||footer.dropped!==0||
          typeof footer.final!=='boolean'||finished)throw Error('gap');
        if(footer.digest!==createHash('sha256').update(lines.length?lines.join('\n')+'\n':'').digest('hex'))throw Error('digest');
        for(const line of lines){if(Buffer.byteLength(line)+1>ROW)throw Error('oversized');batch.push(parseResearchRecord(JSON.parse(line)));}
        finished=footer.final;
      }catch{valid=false;}
    }
    if(valid&&finished)records.push(...batch);else excluded.recording_gap=(excluded.recording_gap??0)+1;
  }
  return {records,excluded};
}
