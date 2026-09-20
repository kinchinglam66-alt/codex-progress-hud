import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConversationNameService } from '../../src/server/conversation-name-service.js';
const fixture=fileURLToPath(new URL('../fixtures/name-server.mjs',import.meta.url));
it('uses the verified launch path for metadata and closes without retaining the name', async () => {
  const service=createConversationNameService({}, {
    resolveExecutable:async()=>process.execPath,
    launch:(exe,cwd)=>spawn(exe,[fixture,'ok'],{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']})
  });
  expect(await service.read('host-one',new AbortController().signal)).toBe('Host title');
  await service.close();
  await expect(service.read('host-one',new AbortController().signal)).rejects.toThrow('NAME_SOURCE_UNAVAILABLE');
});
it('does not launch when disabled during executable discovery', async () => {
  let finish!: (exe:string)=>void, launches=0;
  const service=createConversationNameService({}, {
    resolveExecutable:()=>new Promise<string>(resolve=>{finish=resolve;}),
    launch:(exe,cwd)=>{launches++;return spawn(exe,[fixture,'ok'],{cwd,stdio:['pipe','pipe','pipe']});}
  });
  const read=service.read('host',new AbortController().signal);
  const assertion=expect(read).rejects.toThrow('NAME_SOURCE_UNAVAILABLE');
  const closed=service.close();finish(process.execPath);
  await assertion;await closed;expect(launches).toBe(0);
});
it('retries a failed discovery on a later read without restarting the service',async()=>{
  let discoveries=0,launches=0;
  const service=createConversationNameService({}, {
    resolveExecutable:async()=>{if(++discoveries===1)throw Error('temporary discovery failure');return process.execPath;},
    launch:(exe,cwd)=>{launches++;return spawn(exe,[fixture,'ok'],{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});}
  });
  try{
    await expect(service.read('host-one',new AbortController().signal)).rejects.toThrow('NAME_SOURCE_UNAVAILABLE');
    expect(launches).toBe(0);
    expect(await service.read('host-one',new AbortController().signal)).toBe('Host title');
    expect(discoveries).toBe(2);expect(launches).toBe(1);
  }finally{await service.close();}
});
