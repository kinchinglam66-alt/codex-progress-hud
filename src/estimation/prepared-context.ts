import type {ObserverInput} from './observer-contract.js';

export type ContextMode='full'|'compressed'|'incomplete';

export interface ContextRepresentation {
  mode:ContextMode;
  sourceComplete:boolean;
  originalRecords:number;
  compressedThroughOrdinal:number|null;
  sizing:'tokenizer'|'conservative';
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
