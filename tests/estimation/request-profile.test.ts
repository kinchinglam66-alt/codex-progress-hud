import {expect,it} from 'vitest';
import {createRequestProfile,projectRequestProfile} from '../../src/estimation/request-profile.js';

it('partitions repeated phases without double counting and leaves unseen phases unknown',()=>{
  let now=100;const clock=createRequestProfile(()=>now);
  now=110;clock.phase('accountProcessMs');
  now=140;clock.phase('forkImportMs');
  now=160;clock.phase('accountProcessMs');
  now=170;clock.phase('inferenceMs');
  now=220;clock.phase('deliveryMs');now=225;
  expect(clock.snapshot()).toEqual({sourceMs:10,accountProcessMs:40,forkImportMs:20,
    compactionMs:null,inferenceMs:50,deliveryMs:5,unattributedMs:null,totalMs:125,clockValid:true});
});

it('timeout snapshots do not stop the clock or mutate earlier results',()=>{
  let now=0;const clock=createRequestProfile(()=>now);
  clock.phase('inferenceMs');now=30000;const timeout=clock.snapshot();
  now=31000;clock.phase('deliveryMs');now=31200;
  expect(timeout.inferenceMs).toBe(30000);expect(timeout.totalMs).toBe(30000);
  expect(clock.snapshot()).toMatchObject({inferenceMs:31000,deliveryMs:200,totalMs:31200});
});

it('marks broken clocks invalid instead of emitting negative or fabricated durations',()=>{
  let now=10;const clock=createRequestProfile(()=>now);
  now=5;clock.phase('accountProcessMs');now=Number.NaN;
  expect(clock.snapshot()).toMatchObject({clockValid:false,totalMs:null,sourceMs:null,accountProcessMs:null});
});

it('projects only finite bounded timing metadata and never arbitrary context',()=>{
  expect(projectRequestProfile({sourceMs:5,accountProcessMs:Infinity,inferenceMs:-1,
    totalMs:10,clockValid:true,secret:'PRIVATE'})).toEqual({sourceMs:5,accountProcessMs:null,
      forkImportMs:null,compactionMs:null,inferenceMs:null,deliveryMs:null,unattributedMs:null,totalMs:10,clockValid:true});
  expect(projectRequestProfile(null)).toBeUndefined();
});
