import {mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {readWindowsImage} from '../../src/observer/windows-image-reader.js';

const roots:string[]=[];
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=','base64');
const options=()=>({signal:new AbortController().signal,maxEncodedBytes:4096});

afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

it.skipIf(process.platform!=='win32')('reads bytes from a non-reparse regular file',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hud-win-image-reader-'));roots.push(root);
  const path=join(root,'image.png');await writeFile(path,png);
  await expect(readWindowsImage(path,options())).resolves.toEqual(png);
});

it.skipIf(process.platform!=='win32')('rejects a reparse ancestor before reading bytes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hud-win-image-reader-'));roots.push(root);
  const target=join(root,'target');const linked=join(root,'linked');
  await (await import('node:fs/promises')).mkdir(target);await writeFile(join(target,'image.png'),png);
  await symlink(target,linked,'junction');
  await expect(readWindowsImage(join(linked,'image.png'),options())).rejects.toMatchObject({code:'REPARSE'});
});

it.skipIf(process.platform!=='win32')('rejects a reparse leaf before reading bytes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hud-win-image-reader-'));roots.push(root);
  const target=join(root,'target');const linked=join(root,'linked');
  await (await import('node:fs/promises')).mkdir(target);await writeFile(join(target,'image.png'),png);await symlink(target,linked,'junction');
  await expect(readWindowsImage(linked,options())).rejects.toMatchObject({code:'NOT_REGULAR'});
});

it.skipIf(process.platform!=='win32')('cancels an in-flight helper without exposing its path',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hud-win-image-reader-'));roots.push(root);
  const path=join(root,'image.png');await writeFile(path,png);
  const controller=new AbortController();const pending=readWindowsImage(path,{...options(),signal:controller.signal});
  controller.abort();const error=await pending.catch(caught=>caught);
  expect(error).toMatchObject({code:'CANCELLED',message:'CANCELLED'});expect(String(error)).not.toContain(path);
});
