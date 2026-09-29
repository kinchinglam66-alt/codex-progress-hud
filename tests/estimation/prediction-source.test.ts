import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createMeasurementIdentity,projectPredictionSource,projectMeasurementIdentity} from '../../src/estimation/prediction-source.js';
it('separates instances, turns and conversations without recording their names',()=>{
 const a=createMeasurementIdentity(),b=createMeasurementIdentity(),one=a('private-key','private-turn');
 expect(a('private-key','private-turn')).toEqual(one);
 expect(a('private-key','new-turn').turnRef).not.toBe(one.turnRef);
 expect(a('new-key','private-turn').turnRef).not.toBe(one.turnRef);
 expect(b('private-key','private-turn').instanceId).not.toBe(one.instanceId);
 expect(JSON.stringify(one)).not.toContain('private');
});
it('strictly projects metadata, dropping extra private fields',()=>{
 const identity=createMeasurementIdentity()('k','t'),source={...identity,correlationId:randomUUID(),requestId:1};
 expect(projectPredictionSource({...source,text:'secret'})).toEqual(source);
 expect(projectPredictionSource({...source,requestId:0})).toBeUndefined();
 expect(projectPredictionSource({...source,correlationId:'private'})).toBeUndefined();
 expect(projectMeasurementIdentity({...identity,turnRef:'private'})).toBeUndefined();
});
