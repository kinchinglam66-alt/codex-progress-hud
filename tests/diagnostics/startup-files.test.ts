import {describe,it,expect} from 'vitest';
import {mkdtemp,writeFile,rm,mkdir,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collectStartupFileEvidence,writeStartupFileEvidence} from '../../src/diagnostics/startup-files.js';

describe('startup file evidence',()=>{
  it('records missing files without manufacturing defaults',async()=>{
    const root=await mkdtemp(join(tmpdir(),'hud-startup-evidence-'));
    try{const result=await collectStartupFileEvidence(root,join(root,'auth.token'));
      expect(result.files.settings).toEqual({readable:false,error:'ENOENT'});
      expect(result.token).toEqual({readable:false,error:'ENOENT'});
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('records only allowlisted settings and never credential contents or paths',async()=>{
    const root=await mkdtemp(join(tmpdir(),'hud-startup-evidence-'));
    try{await writeFile(join(root,'settings.json'),JSON.stringify({generation:7,desiredState:'on',secret:'DO_NOT_EMIT'}));
      await writeFile(join(root,'auth.token'),'PRIVATE_TOKEN_NOT_FOR_LOGS');
      await writeFile(join(root,'observer-provider-active.json'),'PRIVATE_ACCOUNT_NOT_FOR_LOGS');
      const result=await collectStartupFileEvidence(root,join(root,'auth.token'));
      expect(result.files.settings).toMatchObject({readable:true,generation:7,desiredState:'on'});
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|DO_NOT_EMIT/);
      expect(JSON.stringify(result)).not.toContain(root);
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('preserves existing diagnostics and records malformed settings',async()=>{
    const root=await mkdtemp(join(tmpdir(),'hud-startup-evidence-'));
    try{await mkdir(join(root,'diagnostics'));await writeFile(join(root,'diagnostics','existing.txt'),'keep');
      await writeFile(join(root,'settings.json'),'not json');
      await writeStartupFileEvidence(root,join(root,'auth.token'));
      const names=await readdir(join(root,'diagnostics'));
      expect(names).toHaveLength(2);expect(await readFile(join(root,'diagnostics','existing.txt'),'utf8')).toBe('keep');
      const report=JSON.parse(await readFile(join(root,'diagnostics',names.find(name=>name.startsWith('startup-files-'))!),'utf8'));
      expect(report.files.settings.settingsReadable).toBe(false);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
