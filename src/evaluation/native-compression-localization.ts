import {createHash} from "node:crypto";
import {runSyntheticSeedOperation, type SeedCompletion} from "./native-seed-operation.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface NativeLocalizationCheckpointObservation {
  envelope: Readonly<Record<string, unknown>>;
  checkpointFingerprint: string;
  compactionTurnId: string;
  compactionItemId: string;
  observedAt: number;
}

export interface NativeLocalizationCheckpointPin {
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly serializedEnvelope: string;
  readonly envelopeHash: string;
  readonly checkpointFingerprint: string;
  readonly compactionTurnId: string;
  readonly compactionItemId: string;
  readonly observedAt: number;
}

function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    const copy = value.map(item => cloneAndFreeze(item)) as T;
    return Object.freeze(copy);
  }
  if (object(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) copy[key] = cloneAndFreeze(child);
    return Object.freeze(copy) as T;
  }
  return value;
}

function serializedEnvelope(envelope: Readonly<Record<string, unknown>>): string {
  if (!object(envelope)) throw Error("NATIVE_LOCALIZATION_CHECKPOINT_INVALID");
  let serialized: string | undefined;
  try { serialized = JSON.stringify(envelope); } catch { throw Error("NATIVE_LOCALIZATION_CHECKPOINT_INVALID"); }
  if (typeof serialized !== "string" || serialized.length === 0) throw Error("NATIVE_LOCALIZATION_CHECKPOINT_INVALID");
  return serialized;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateObservation(observation: NativeLocalizationCheckpointObservation): string {
  if (!observation || !object(observation.envelope) ||
    !SHA256.test(observation.checkpointFingerprint) ||
    typeof observation.compactionTurnId !== "string" || observation.compactionTurnId.length === 0 ||
    typeof observation.compactionItemId !== "string" || observation.compactionItemId.length === 0 ||
    !Number.isSafeInteger(observation.observedAt) || observation.observedAt < 0) {
    throw Error("NATIVE_LOCALIZATION_CHECKPOINT_INVALID");
  }
  return serializedEnvelope(observation.envelope);
}

/** Keep a private, immutable copy of the full compacted envelope and all
 * provider identity evidence needed to compare the same checkpoint later. */
export function pinNativeLocalizationCheckpoint(
  observation: NativeLocalizationCheckpointObservation,
): NativeLocalizationCheckpointPin {
  const serialized = validateObservation(observation);
  const envelope = cloneAndFreeze(JSON.parse(serialized) as Record<string, unknown>);
  return Object.freeze({
    envelope,
    serializedEnvelope: serialized,
    envelopeHash: hash(serialized),
    checkpointFingerprint: observation.checkpointFingerprint,
    compactionTurnId: observation.compactionTurnId,
    compactionItemId: observation.compactionItemId,
    observedAt: observation.observedAt,
  });
}

/** Compare the serialized envelope as well as the parsed checkpoint identity.
 * A same-fingerprint envelope mutation is still a fail-stop boundary breach. */
export function assertNativeLocalizationCheckpointUnchanged(
  pin: NativeLocalizationCheckpointPin,
  observation: NativeLocalizationCheckpointObservation,
): void {
  const serialized = validateObservation(observation);
  const unchanged = hash(serialized) === pin.envelopeHash &&
    serialized === pin.serializedEnvelope &&
    observation.checkpointFingerprint === pin.checkpointFingerprint &&
    observation.compactionTurnId === pin.compactionTurnId &&
    observation.compactionItemId === pin.compactionItemId &&
    observation.observedAt === pin.observedAt;
  if (!unchanged) throw Error("NATIVE_LOCALIZATION_CHECKPOINT_CHANGED");
}

export interface NativeLocalizationOperation<T extends SeedCompletion> {
  beforeDispatch(): Promise<void>;
  dispatch(onDispatch: () => void): Promise<T>;
  terminal(state: "completed" | "unconfirmed" | "cancelled", result?: T): Promise<void>;
  settleConfirmed(): Promise<void>;
  settleUnconfirmed(): Promise<void>;
  cancelBeforeDispatch(): Promise<void>;
}

/** Bounded localization operations use the existing fail-closed seed state
 * machine. This seam gives the diagnostic one operation vocabulary without
 * introducing a second settlement implementation. */
export function runNativeLocalizationOperation<T extends SeedCompletion>(
  operation: NativeLocalizationOperation<T>,
): Promise<T> {
  return runSyntheticSeedOperation(operation);
}
