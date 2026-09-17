import {expect,it} from 'vitest';
import {comparisonThreadParameters,createComparisonForkRegistry} from '../../src/evaluation/native-comparison-input.js';
it('refuses source reuse, duplicate forks across requests and multiple forks for one request',()=>{
 const registry=createComparisonForkRegistry();
 registry.record('seed','source','seed-fork');
 registry.record('0-native','source','fresh-fork');
 expect(()=>registry.record('1-native','source','fresh-fork')).toThrow('TRIAL_FORK_REUSED');
 expect(()=>registry.record('0-native','source','another-fork')).toThrow('TRIAL_REQUEST_REFORKED');
 expect(()=>registry.record('2-native','source','source')).toThrow('TRIAL_FORK_INVALID');
 registry.record('1-native','source','next-fork');
 expect(registry.require('1-native')).toBe('next-fork');
 expect(()=>registry.require('2-native')).toThrow('TRIAL_FORK_MISSING');
 expect(registry.snapshot()).toEqual([{request:'seed',forkId:'seed-fork'},{request:'0-native',forkId:'fresh-fork'},{request:'1-native',forkId:'next-fork'}]);
});
it('keeps base preservation policy identical on both routes and refuses a native mismatch',()=>{
 const source={baseInstructions:'same trusted base',developerInstructions:'observer policy',sandbox:'read-only'};
 const native=comparisonThreadParameters('thread/fork',source,'same trusted base','retrieve source facts');
 const history=comparisonThreadParameters('thread/start',{developerInstructions:'observer policy',sandbox:'read-only'},'same trusted base','retrieve source facts');
 expect(native).toEqual(history);
 expect(native).toEqual({baseInstructions:'same trusted base',developerInstructions:'observer policy\nretrieve source facts',sandbox:'read-only'});
 expect(source.developerInstructions).toBe('observer policy');
 expect(()=>comparisonThreadParameters('thread/fork',{...source,baseInstructions:'different'},'same trusted base','retrieve source facts')).toThrow('TRIAL_INSTRUCTIONS_MISMATCH');
 expect(()=>comparisonThreadParameters('thread/start',{},'same trusted base','retrieve source facts')).toThrow('TRIAL_TRUSTED_INSTRUCTIONS_MISSING');
});
