export const NATIVE_CONTEXT_METRICS_VERSION = 'native-context-metrics-v1';

export type NativeContextStrategy = 'native' | 'history';
export type NativeContextProcessState = 'cold' | 'warm';

export interface NativeContextPhaseDurations {
  /** Disjoint elapsed stages; deliveryMs is only post-inference delivery. */
  readonly queueMs: number;
  readonly accountProcessMs: number;
  readonly snapshotMs: number;
  readonly forkImportMs: number;
  readonly compactionMs: number;
  readonly inferenceMs: number;
  readonly deliveryMs: number;
}

export interface NativeContextPhaseRecord {
  readonly strategy: NativeContextStrategy;
  readonly version: string;
  readonly processState: NativeContextProcessState;
  readonly contextIdentityHash: string;
  readonly contextAgeMs: number;
  readonly knownTokens: number;
  readonly cacheTokens: number;
  readonly unknownTokenCount: number;
  readonly stages: NativeContextPhaseDurations;
}

export interface NativeContextPhaseRecordInput {
  readonly strategy: NativeContextStrategy;
  readonly version: string;
  readonly processState: NativeContextProcessState;
  readonly contextIdentityHash: string;
  readonly contextAgeMs: number;
  readonly knownTokens: number;
  readonly cacheTokens: number;
  readonly unknownTokenCount: number;
  readonly stages: NativeContextPhaseDurations;
}

export interface NativeContextPair {
  readonly history: NativeContextPhaseRecord;
  readonly native: NativeContextPhaseRecord;
}

export interface NativeContextGateResult {
  readonly passed: boolean;
  readonly validPairCount: number;
  readonly medianPreparationImprovement: number | null;
  readonly medianFirstValidDeliveryRegression: number | null;
  readonly reasons: readonly string[];
}

const STAGE_KEYS = [
  'queueMs',
  'accountProcessMs',
  'snapshotMs',
  'forkImportMs',
  'compactionMs',
  'inferenceMs',
  'deliveryMs',
] as const satisfies readonly (keyof NativeContextPhaseDurations)[];

const MAX_DURATION_MS = 86_400_000;
const MAX_CONTEXT_AGE_MS = 31_536_000_000;
const MAX_TOKEN_COUNT = Number.MAX_SAFE_INTEGER;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isFiniteNumber(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKEN_COUNT;
}

function isPhaseDurations(value: unknown): value is NativeContextPhaseDurations {
  if (!isRecord(value) || !hasExactKeys(value, STAGE_KEYS)) return false;
  return STAGE_KEYS.every((key) => isFiniteNumber(value[key], MAX_DURATION_MS));
}

function isPhaseRecord(value: unknown): value is NativeContextPhaseRecord {
  if (!isRecord(value) || !hasExactKeys(value, [
    'strategy', 'version', 'processState', 'contextIdentityHash', 'contextAgeMs',
    'knownTokens', 'cacheTokens', 'unknownTokenCount', 'stages',
  ])) return false;

  return (value.strategy === 'native' || value.strategy === 'history')
    && (value.processState === 'cold' || value.processState === 'warm')
    && typeof value.version === 'string'
    && value.version.length > 0
    && value.version.length <= 128
    && HASH_PATTERN.test(String(value.contextIdentityHash))
    && isFiniteNumber(value.contextAgeMs, MAX_CONTEXT_AGE_MS)
    && isSafeCount(value.knownTokens)
    && isSafeCount(value.cacheTokens)
    && value.cacheTokens <= value.knownTokens
    && isSafeCount(value.unknownTokenCount)
    && isPhaseDurations(value.stages);
}

export function createNativeContextPhaseRecord(input: NativeContextPhaseRecordInput): NativeContextPhaseRecord {
  if (!isPhaseRecord(input)) throw new TypeError('invalid native context phase record');
  const stages = Object.freeze({...input.stages});
  return Object.freeze({
    strategy: input.strategy,
    version: input.version,
    processState: input.processState,
    contextIdentityHash: input.contextIdentityHash,
    contextAgeMs: input.contextAgeMs,
    knownTokens: input.knownTokens,
    cacheTokens: input.cacheTokens,
    unknownTokenCount: input.unknownTokenCount,
    stages,
  });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function preparationMs(record: NativeContextPhaseRecord): number {
  const {stages} = record;
  return stages.queueMs + stages.accountProcessMs + stages.snapshotMs
    + stages.forkImportMs + stages.compactionMs;
}
function firstValidDeliveryMs(record:NativeContextPhaseRecord):number {
  return preparationMs(record)+record.stages.inferenceMs+record.stages.deliveryMs;
}

function isMatchedPair(value: unknown): value is NativeContextPair {
  if (!isRecord(value) || !hasExactKeys(value, ['history', 'native'])) return false;
  const history = value.history;
  const native = value.native;
  return isPhaseRecord(history)
    && isPhaseRecord(native)
    && history.strategy === 'history'
    && native.strategy === 'native'
    && history.contextIdentityHash === native.contextIdentityHash
    && history.version === native.version
    // Preserve actual process states independently: resetting a native owner
    // during a repeat request is a cost, not grounds to discard a warm pair.
    && preparationMs(history) > 0
    && preparationMs(native) >= 0;
}

/** Prospective v2 stage gate only, not a release or lifecycle-cost approval.
 * Input order is the registered cold / same-turn / new-turn checkpoint order.
 * Invalid evidence must retain its index; never filter and shift stage labels. */
export function evaluateNativeContextSplitPairs(
  pairs: readonly NativeContextPair[], invalidIndices: readonly number[] = [],
) {
  const names = ['cold', 'same-turn', 'new-turn'] as const;
  const reasons: string[] = [];
  const rows = Array.isArray(pairs) ? pairs : [];
  if (rows.length !== 3) reasons.push('requires_exactly_three_checkpoints');
  const invalidEvidence = !Array.isArray(invalidIndices) || invalidIndices.length > 0;
  if (invalidEvidence) reasons.push('invalid_checkpoint_evidence');
  const invalid = new Set(Array.isArray(invalidIndices) ? invalidIndices : [0, 1, 2]);
  const seen = new Set<string>();
  let version: string | undefined;
  let validPairCount = 0;
  const stages = names.map((stage, index) => {
    const pair = rows[index];
    if (!isMatchedPair(pair) || invalid.has(index)) {
      reasons.push(`${stage}:invalid_pair`);
      return Object.freeze({stage, preparationPassed:false, deliveryPassed:false});
    }
    const hash = pair.history.contextIdentityHash;
    if (seen.has(hash) || (version !== undefined && pair.history.version !== version)
      || pair.history.processState !== (index === 0 ? 'cold' : 'warm')
      || (index === 0 && pair.native.processState !== 'cold')) {
      reasons.push(`${stage}:checkpoint_mismatch`);
      return Object.freeze({stage, preparationPassed:false, deliveryPassed:false});
    }
    seen.add(hash); version = pair.history.version; validPairCount++;
    const historyPreparationMs = preparationMs(pair.history);
    const nativePreparationMs = preparationMs(pair.native);
    const historyDeliveryMs = firstValidDeliveryMs(pair.history);
    const nativeDeliveryMs = firstValidDeliveryMs(pair.native);
    // Compare durations directly so exact 30% equality is not rejected by 1-ratio rounding.
    const preparationPassed = nativePreparationMs <= historyPreparationMs * (index === 0 ? 0.7 : 1);
    const deliveryPassed = nativeDeliveryMs <= historyDeliveryMs;
    if (!preparationPassed) reasons.push(`${stage}:preparation_regression`);
    if (!deliveryPassed) reasons.push(`${stage}:delivery_regression`);
    if (pair.native.knownTokens > pair.history.knownTokens
      || pair.native.unknownTokenCount > pair.history.unknownTokenCount) {
      if (!reasons.includes('unexplained_token_increase')) reasons.push('unexplained_token_increase');
    }
    return Object.freeze({stage, preparationPassed, deliveryPassed,
      historyPreparationMs, nativePreparationMs, historyDeliveryMs, nativeDeliveryMs});
  });
  return Object.freeze({version:'native-context-split-v2' as const,
    passed:reasons.length === 0, validPairCount, stages:Object.freeze(stages), reasons:Object.freeze(reasons)});
}

/** Prospective v3: usage is reported, never inferred to be free or cheaper. */
export function evaluateNativeContextSplitUsagePairs(pairs:readonly NativeContextPair[],invalidIndices:readonly number[]=[]){
  const previous=evaluateNativeContextSplitPairs(pairs,invalidIndices);
  const reasons=previous.reasons.filter(reason=>reason!=='unexplained_token_increase');
  const counts=(row:NativeContextPhaseRecord)=>Object.freeze({knownTokens:row.knownTokens,
    cacheTokens:row.cacheTokens,unknownTokenCount:row.unknownTokenCount});
  const usage=(['cold','same-turn','new-turn'] as const).map((stage,index)=>{
    const pair=Array.isArray(pairs)?pairs[index]:undefined;
    if(!isMatchedPair(pair))return Object.freeze({stage,history:null,native:null,completeCostComparable:false});
    return Object.freeze({stage,history:counts(pair.history),native:counts(pair.native),
      completeCostComparable:pair.history.unknownTokenCount===0&&pair.native.unknownTokenCount===0});
  });
  return Object.freeze({...previous,version:'native-context-split-v3' as const,
    passed:reasons.length===0,reasons:Object.freeze(reasons),usagePolicy:'report-only' as const,
    usage:Object.freeze(usage)});
}

export function evaluateNativeContextPairs(pairs: readonly NativeContextPair[]): NativeContextGateResult {
  const seen=new Set<string>();
  const validPairs = Array.isArray(pairs) ? pairs.filter(isMatchedPair).filter(pair=>{
    const identity=pair.history.contextIdentityHash;
    if(seen.has(identity))return false;
    seen.add(identity);return true;
  }) : [];
  const reasons: string[] = [];
  const medianPreparationImprovement = validPairs.length === 0
    ? null
    : 1 - median(validPairs.map((pair) => preparationMs(pair.native)))
      / median(validPairs.map((pair) => preparationMs(pair.history)));
  const medianFirstValidDeliveryRegression = validPairs.length === 0
    ? null
    : median(validPairs.map((pair) => firstValidDeliveryMs(pair.native)))
      / median(validPairs.map((pair) => firstValidDeliveryMs(pair.history)))-1;

  if (validPairs.length < 3) reasons.push('requires_three_valid_matched_pairs');
  if (validPairs.length >= 3 && (medianPreparationImprovement === null || medianPreparationImprovement < 0.30)) {
    reasons.push('less_than_30_percent_median_preparation_improvement');
  }
  if (validPairs.length >= 3 && (medianFirstValidDeliveryRegression === null || medianFirstValidDeliveryRegression > 0)) {
    reasons.push('median_first_valid_delivery_regression');
  }

  if (validPairs.some(({history, native}) => native.unknownTokenCount > history.unknownTokenCount
    || native.knownTokens > history.knownTokens)) {
    reasons.push('unexplained_token_increase');
  }

  const warmPairs = validPairs.filter(({history}) => history.processState === 'warm');
  if(validPairs.length>=3&&warmPairs.length===0)reasons.push('warm_evidence_missing');
  if (warmPairs.length > 0 && (median(warmPairs.map((pair) => preparationMs(pair.native)))
    > median(warmPairs.map((pair) => preparationMs(pair.history))) ||
    median(warmPairs.map((pair)=>firstValidDeliveryMs(pair.native)))>
    median(warmPairs.map((pair)=>firstValidDeliveryMs(pair.history))))) {
    reasons.push('warm_regression');
  }

  return Object.freeze({
    passed: reasons.length === 0,
    validPairCount: validPairs.length,
    medianPreparationImprovement,
    medianFirstValidDeliveryRegression,
    reasons: Object.freeze(reasons),
  });
}
