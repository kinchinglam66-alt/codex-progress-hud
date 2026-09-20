import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,constants} from 'node:fs';
import {copyFile,lstat,mkdir,readdir,rename,writeFile} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';

const dataFiles=new Set(['auth.token','settings.json','install.json','goal-checkpoint.json']);
const dataDirectories=new Set(['observer-accounting','pilot-observations','residual-research','logs','diagnostics']);
const electronEntries=new Set(['Local State','Preferences','Local Storage','Network','Shared Dictionary']);
const required=['auth.token','settings.json','install.json','observer-pilot.json','observer-provider-active.json'];
async function exists(path:string){try{await lstat(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
async function digest(path:string){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
function contained(root:string,path:string){const value=relative(root,path);return value!==''&&!isAbsolute(value)&&!value.startsWith(`..${sep}`)&&value!=='..';}

/** Explicit, offline migration. Originals are never changed or removed. */
export async function migrateHudData(options:{source:string;destination:string;assertStopped:()=>Promise<void>;secureStage:(stage:string)=>Promise<void>}){
  const source=resolve(options.source),destination=resolve(options.destination);
  if(source===destination||contained(source,destination)||contained(destination,source))throw Error('MIGRATION_PATHS_OVERLAP');
  await options.assertStopped();
  if(await exists(destination))throw Error('MIGRATION_DESTINATION_EXISTS');
  if((await lstat(source)).isSymbolicLink())throw Error('MIGRATION_REPARSE_SOURCE');
  for(const name of required)if(!(await exists(join(source,name))))throw Error('MIGRATION_REQUIRED_FILE_MISSING');
  const planned:Array<{source:string;target:string;size:number;hash:string}>=[];
  const skipped:string[]=[];
  async function walk(path:string,target:string){
    const stat=await lstat(path);
    if(stat.isSymbolicLink())throw Error('MIGRATION_REPARSE_SOURCE');
    if(stat.isDirectory()){
      for(const name of (await readdir(path)).sort())await walk(join(path,name),join(target,name));
    }else if(stat.isFile())planned.push({source:path,target,size:stat.size,hash:await digest(path)});
    else throw Error('MIGRATION_UNSUPPORTED_ENTRY');
  }
  for(const name of (await readdir(source)).sort()){
    if(dataFiles.has(name)||dataDirectories.has(name)||/^observer-[a-z0-9-]+\.(json|db)(-wal|-shm|-journal)?$/.test(name))await walk(join(source,name),name);
    else if(electronEntries.has(name))await walk(join(source,name),join('electron',name));
    else skipped.push(name);
  }
  await options.assertStopped();
  const stage=join(dirname(destination),`${basename(destination)}.migration-${randomUUID()}`);
  await mkdir(stage,{mode:0o700});
  // Windows callers must remove inherited access before copying credentials.
  await options.secureStage(stage);
  for(const file of planned){
    const target=join(stage,file.target);if(!contained(stage,target))throw Error('MIGRATION_TARGET_ESCAPE');
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    await copyFile(file.source,target,constants.COPYFILE_EXCL);
    if(await digest(target)!==file.hash||await digest(file.source)!==file.hash)throw Error('MIGRATION_SOURCE_CHANGED');
  }
  await options.assertStopped();
  // Rebuild selected inventory to detect additions/removals as well as edits.
  const expected=JSON.stringify(planned);
  planned.length=0;
  for(const name of (await readdir(source)).sort()){
    if(dataFiles.has(name)||dataDirectories.has(name)||/^observer-[a-z0-9-]+\.(json|db)(-wal|-shm|-journal)?$/.test(name))await walk(join(source,name),name);
    else if(electronEntries.has(name))await walk(join(source,name),join('electron',name));
  }
  if(JSON.stringify(planned)!==expected)throw Error('MIGRATION_SOURCE_CHANGED');
  if(await exists(destination))throw Error('MIGRATION_DESTINATION_EXISTS');
  const report={version:1,completedAt:new Date().toISOString(),files:planned.map(({target,size,hash})=>({path:target,size,sha256:hash})),skipped,originalsPreserved:true};
  await writeFile(join(stage,'migration-report.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
  await rename(stage,destination);
  return {destination,fileCount:planned.length,bytes:planned.reduce((sum,file)=>sum+file.size,0),skipped,originalsPreserved:true};
}
