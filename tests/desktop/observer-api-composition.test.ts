import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, expect, it, vi} from 'vitest';
const transport = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<Response>>());
vi.mock('../../src/desktop/observer-api-transport.js', () => ({createObserverApiTransport: () => Object.assign(transport, {close: async () => undefined})}));
vi.mock('../../src/estimation/observer-api-assets.js', () => ({loadObserverApiAssets: async () => ({instructions:'fixture', schema:{type:'object'}})}));
import {loadDesktopObserverPilot} from '../../src/desktop/observer-pilot.js';
const directories: string[] = [];
afterEach(async () => {transport.mockReset(); await Promise.all(directories.splice(0).map(path => rm(path,{recursive:true,force:true})));});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(),'hud-api-compose-')); directories.push(directory);
  const pilot = await loadDesktopObserverPilot({dataDirectory:directory,resourcesDirectory:directory,environment:{},dialog:{showMessageBox:async()=>({response:1})},consentProtection:{protect:v=>v,unprotect:v=>v}});
  await pilot.providerSettings.saveProviderSettings({...pilot.providerSettings.status(),draft:{selected:'api',api:{profileId:'fixture',name:'Fixture',baseUrl:'https://api.example.test/v1',protocol:'responses',model:'fixture',maxOutputTokens:100,dailyCallLimit:10}},secret:'synthetic-key'});
  return pilot;
}
it('production observations retry one transient failure, never more than once', async () => {
  const pilot = await setup();
  transport.mockImplementation(async()=>new Response('{}',{status:503,headers:{'retry-after':'0'}}));
  try {
    await pilot.providerSettings.activateProvider({...pilot.providerSettings.status(),selected:'api'});
    const result = await pilot.workers[0]!.observe({goalSummary:'Fixture',activeSeconds:1,runtime:'running',messages:[{kind:'user',text:'Fixture',truncated:false}],truncated:false},new AbortController().signal,'fixture');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('process_error');
  } finally {await pilot.close();}
});
it('an explicit synthetic trial makes exactly one attempt on a transient failure', async () => {
  const pilot = await setup();
  transport.mockImplementation(async()=>new Response('{}',{status:503}));
  try {
    await expect(pilot.providerSettings.trialProvider({...pilot.providerSettings.status()})).rejects.toThrow('PROVIDER_TRIAL_FAILED');
    expect(transport).toHaveBeenCalledTimes(1);
  } finally {await pilot.close();}
});
