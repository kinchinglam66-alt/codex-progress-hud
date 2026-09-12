import type {Outcome} from './contract.js';
/** Local adapter metadata; never write these source keys to disk. */
export interface ResearchOwner {sessionKey:string;turnKey:string;sourceEpoch:number;generation:number}
export interface ResearchBoundary extends ResearchOwner {
  activeSeconds:number;trusted:boolean;state:'running'|'waiting'|'paused'|'unknown';
  evidenceId:string;outcome?:Outcome;
}
