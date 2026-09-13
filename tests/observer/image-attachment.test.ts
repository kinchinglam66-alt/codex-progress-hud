import {mkdtemp,writeFile,rm,mkdir,symlink,rename,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {afterEach,expect,it} from 'vitest';
import {resolveImageAttachment} from '../../src/observer/image-attachment.js';

const roots:string[]=[];
const execFile=promisify(execFileCallback);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=','base64');
const options=()=>({signal:new AbortController().signal,maxEncodedBytes:4096});
async function file(bytes:Buffer=png){const root=await mkdtemp(join(tmpdir(),'hud-image-'));roots.push(root);const path=join(root,'image.png');await writeFile(path,bytes);return path;}
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

it('delivers original local image bytes as native data, with a content digest',async()=>{
  const path=await file();const result=await resolveImageAttachment({type:'local_image',path},options());
  expect(result.state).toBe('available');if(result.state!=='available')throw Error('expected image');
  expect(Buffer.from(result.imageUrl.split(',')[1]!,'base64')).toEqual(png);
  expect(result.imageUrl.startsWith('data:image/png;base64,')).toBe(true);
  expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(result.encodedBytes).toBe(Buffer.byteLength(result.imageUrl));
});
it('marks only absent files missing',async()=>{
  const path=await file();expect(await resolveImageAttachment({type:'local_image',path:path+'.absent'},options())).toEqual({state:'missing'});
});
it('rejects a junction ancestor before reading the image',async()=>{
  const path=await file();const root=roots.at(-1)!;const link=join(root,'linked');
  await symlink(root,link,'junction');
  await expect(resolveImageAttachment({type:'local_image',path:join(link,'image.png')},options())).rejects.toMatchObject({code:'IMAGE_PATH_REJECTED'});
  await rm(link);
});
it('rejects an ancestor that was deterministically swapped for a junction',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hud-image-swap-'));roots.push(root);
  const original=join(root,'source');const replacement=join(root,'replacement');
  await mkdir(original);await writeFile(join(original,'image.png'),png);await mkdir(replacement);
  await writeFile(join(replacement,'image.png'),Buffer.concat([png,Buffer.from([1])]));
  await rename(original,join(root,'source-safe'));await symlink(replacement,original,'junction');
  await expect(resolveImageAttachment({type:'local_image',path:join(original,'image.png')},options())).rejects.toMatchObject({code:'IMAGE_PATH_REJECTED'});
});
it('changes the content digest when the same path contains a different image',async()=>{
  const path=await file();const first=await resolveImageAttachment({type:'local_image',path},options());
  const changed=Buffer.concat([png,Buffer.from([0])]);await writeFile(path,changed);
  const second=await resolveImageAttachment({type:'local_image',path},options());
  if(first.state!=='available'||second.state!=='available')throw Error('expected image');
  expect(second.digest).not.toBe(first.digest);
});
it('rejects directory attachments rather than calling them missing',async()=>{
  const path=await file();await mkdir(path+'.dir');
  await expect(resolveImageAttachment({type:'local_image',path:path+'.dir'},options())).rejects.toMatchObject({code:'IMAGE_PATH_REJECTED'});
});
it('rejects non-image bytes without leaking their path in the error',async()=>{
  const path=await file(Buffer.from('private fixture text'));
  await expect(resolveImageAttachment({type:'local_image',path},options())).rejects.toMatchObject({message:'IMAGE_FORMAT_UNSUPPORTED'});
});
it('enforces encoded capacity before importing',async()=>{
  const path=await file();await expect(resolveImageAttachment({type:'local_image',path},{...options(),maxEncodedBytes:32})).rejects.toMatchObject({code:'IMAGE_CAPACITY_EXCEEDED'});
});
it('validates embedded image bytes and rejects remote fetching',async()=>{
  const result=await resolveImageAttachment({type:'input_image',imageUrl:'data:image/png;base64,'+png.toString('base64')},options());
  expect(result.state).toBe('available');
  await expect(resolveImageAttachment({type:'input_image',imageUrl:'https://example.invalid/image.png'},options())).rejects.toMatchObject({code:'IMAGE_FORMAT_UNSUPPORTED'});
});
it('rejects noncanonical base64 and mismatched MIME types',async()=>{
  for(const imageUrl of ['data:image/png;base64,!!!!','data:image/jpeg;base64,'+png.toString('base64')])
    await expect(resolveImageAttachment({type:'input_image',imageUrl},options())).rejects.toMatchObject({code:'IMAGE_FORMAT_UNSUPPORTED'});
});
it('cancels before reading an attachment',async()=>{
  const controller=new AbortController();controller.abort();
  const error=await resolveImageAttachment({type:'local_image',path:await file()},{...options(),signal:controller.signal}).catch(caught=>caught);
  expect(error).toMatchObject({code:'IMAGE_CANCELLED',message:'IMAGE_CANCELLED'});
});
it('does not classify a permission failure as a missing file',async()=>{
  const path=await file();
  if(process.platform==='win32')await execFile('icacls.exe',[path,'/deny','*S-1-1-0:(R)']);
  else await chmod(path,0o000);
  try {
    const error=await resolveImageAttachment({type:'local_image',path},options()).catch(caught=>caught);
    expect(error).toMatchObject({code:'IMAGE_READ_FAILED'});
    expect(error).not.toMatchObject({state:'missing'});
  } finally {
    if(process.platform==='win32')await execFile('icacls.exe',[path,'/reset']);
    else await chmod(path,0o600);
  }
});
it.each(['relative.png','\\\\server\\share\\image.png','C:\\temp\\image.png:secret'])('rejects unsafe attachment path %s',async path=>{
  await expect(resolveImageAttachment({type:'local_image',path},options())).rejects.toMatchObject({code:'IMAGE_PATH_REJECTED'});
});
