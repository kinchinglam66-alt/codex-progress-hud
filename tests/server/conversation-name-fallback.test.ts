import {beforeEach,expect,it,vi} from 'vitest';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const pinned=vi.hoisted(()=>vi.fn());
vi.mock('../../src/server/codex-name-launch.js',()=>({findPinnedCodex:pinned,nameProcessArguments:()=>[]}));
import {createConversationNameService} from '../../src/server/conversation-name-service.js';
const fixture=fileURLToPath(new URL('../fixtures/name-server.mjs',import.meta.url));
beforeEach(()=>{pinned.mockReset();});
it.skipIf(process.platform!=='win32')('uses only a pinned host-selected fallback after desktop discovery fails',async()=>{
 pinned.mockRejectedValueOnce(Error('unqualified desktop runtime')).mockResolvedValueOnce(process.execPath);
 const service=createConversationNameService({LOCALAPPDATA:'C:/synthetic'}, {
  launch:(exe,cwd)=>spawn(exe,[fixture,'ok'],{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']})
 },'C:/installed/observer-runtime');
 try{
  expect(await service.read('host-one',new AbortController().signal)).toBe('Host title');
  expect(pinned.mock.calls).toEqual([[join('C:/synthetic','OpenAI','Codex','bin')],['C:/installed/observer-runtime']]);
 }finally{await service.close();}
});
it.skipIf(process.platform!=='win32')('never launches if both runtime candidates fail pin verification',async()=>{
 pinned.mockRejectedValue(Error('unqualified'));const launch=vi.fn();
 const service=createConversationNameService({LOCALAPPDATA:'C:/synthetic'},{launch},'C:/installed/observer-runtime');
 try{
  await expect(service.read('host-one',new AbortController().signal)).rejects.toThrow('NAME_SOURCE_UNAVAILABLE');
  expect(pinned).toHaveBeenCalledTimes(2);expect(launch).not.toHaveBeenCalled();
 }finally{await service.close();}
});
