import {createHmac,randomUUID} from 'node:crypto';
import {projectRequestCorrelation} from './request-correlation.js';

/** Diagnostic identity, never an authorization capability or model input. */
export interface MeasurementIdentity {instanceId:string;turnRef:string}
export interface PredictionSource extends MeasurementIdentity {correlationId:string;requestId:number}
export function projectMeasurementIdentity(value:unknown):MeasurementIdentity|undefined {
  if(!value||typeof value!=='object')return undefined;
  const v=value as Record<string,unknown>,instanceId=projectRequestCorrelation(v.instanceId);
  return instanceId&&typeof v.turnRef==='string'&&/^[a-f0-9]{64}$/.test(v.turnRef)?{instanceId,turnRef:v.turnRef}:undefined;
}
export function projectPredictionSource(value:unknown):PredictionSource|undefined {
  const identity=projectMeasurementIdentity(value);if(!identity)return undefined;
  const v=value as Record<string,unknown>,correlationId=projectRequestCorrelation(v.correlationId);
  return correlationId&&typeof v.requestId==='number'&&Number.isSafeInteger(v.requestId)&&v.requestId>0?
    {...identity,correlationId,requestId:v.requestId}:undefined;
}
export function createMeasurementIdentity(){
  const instanceId=randomUUID(),salt=randomUUID();
  return (key:string,turnKey:string):MeasurementIdentity=>({instanceId,
    turnRef:createHmac('sha256',salt).update(JSON.stringify([key,turnKey])).digest('hex')});
}
