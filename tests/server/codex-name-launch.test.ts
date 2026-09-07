import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPinnedCodex, nameProcessArguments } from '../../src/server/codex-name-launch.js';

it('selects only a hash-matched executable from the bounded host installation directory', async () => {
  const root=await mkdtemp(join(tmpdir(),'hud-codex-pin-'));
  try {
    await mkdir(join(root,'a'));await mkdir(join(root,'b'));
    await writeFile(join(root,'a','codex.exe'),'wrong');
    await writeFile(join(root,'b','codex.exe'),'trusted synthetic bytes');
    const hash=createHash('sha256').update('trusted synthetic bytes').digest('hex');
    expect(await findPinnedCodex(root, ['0'.repeat(64), hash])).toBe(join(root,'b','codex.exe'));
    await expect(findPinnedCodex(root, [])).rejects.toThrow('NAME_SOURCE_UNAVAILABLE');
    await expect(findPinnedCodex(root, ['invalid', hash])).rejects.toThrow('NAME_SOURCE_UNAVAILABLE');
    expect(await findPinnedCodex(root,hash)).toBe(join(root,'b','codex.exe'));
    await writeFile(join(root,'b','codex.exe'),'changed');
    await expect(findPinnedCodex(root,hash)).rejects.toThrow('NAME_SOURCE_UNAVAILABLE');
  } finally {await rm(root,{recursive:true,force:true});}
});
it('uses metadata stdio with task-capable integrations disabled', () => {
  const args=nameProcessArguments();
  expect(args.slice(0,3)).toEqual(['app-server','--listen','stdio://']);
  for(const feature of ['plugins','hooks','apps','code_mode_host','multi_agent']) {
    expect(args.some((arg,index)=>arg==='--disable' && args[index+1]===feature)).toBe(true);
  }
  expect(args).not.toContain('exec');
});
