import type {ObserverInput} from './observer-contract.js';

export type ContextMode='full'|'compressed'|'incomplete';

export interface ContextRepresentation {
  mode:ContextMode;
  sourceComplete:boolean;
  missingImages?:number|undefined;
  inferenceEligible?:boolean|undefined;
  sourceGaps?:NonNullable<ObserverInput['representation']>['sourceGaps'];
  originalRecords:number;
  sessionCoveredRecords?:number;
  sourceRepresentation?:'raw_history'|'upstream_compacted'|undefined;
  checkpointBootstrapped?:boolean|undefined;
  checkpointEncodedBytes?:number|undefined;
  checkpointItemCount?:number|undefined;
  compressedThroughOrdinal:number|null;
  sizing:'tokenizer'|'conservative';
  importedThroughOrdinal?:number|null|undefined;
  importedRecords?:number|undefined;
  importedEncodedBytes?:number|undefined;
  confirmedCompactions?:number|undefined;
  confirmedCompactionThroughOrdinal?:number|null|undefined;
  compressionState?:'none'|'confirmed'|undefined;
  residentBound?:'policy_assumed'|'unverified'|undefined;
  retainedSummaryReserveBytes?:number|undefined;
  contextCapacityBytes?:number|undefined;
  budgetStatus?:'trusted'|'unconfigured'|'exhausted'|undefined;
}

export interface PreparedContext {
  input:ObserverInput;
  representation:ContextRepresentation;
  metrics?:ContextPreparationMetrics;
}

/** Original text counters exclude protocol overhead; prepared counters include it. */
export interface ContextPreparationMetrics {
  sizing:'tokenizer'|'conservative';
  originalTextBytes:number;
  originalTextTokenEstimate:number;
  preparedRequestBytes:number;
  preparedTokenEstimate:number;
  compressionCalls:number;
  cachedCompressionCalls:number;
}
