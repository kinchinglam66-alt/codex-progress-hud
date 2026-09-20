import type { ProviderConfig } from './observer-provider-config.js';

export interface ProviderOwner {
  close(): Promise<void>;
  inspect(signal: AbortSignal): Promise<{label: string; fingerprint: string}>;
  /** Owner-local startup validation; ordinary inspections remain fresh. */
  inspectSelection?(signal: AbortSignal): Promise<{label:string;fingerprint:string}>;
}

export type ProviderSelectionState = 'inactive' | 'switching' | 'ready' | 'failed';
export interface ProviderSelectionStatus {
  generation: number;
  state: ProviderSelectionState;
}

export interface ProviderSelectionOptions {
  open(config: ProviderConfig, signal: AbortSignal): Promise<ProviderOwner>;
  persist(config: ProviderConfig): Promise<void>;
}

export interface ProviderSelection {
  select(config: ProviderConfig, signal: AbortSignal): Promise<void>;
  status(): ProviderSelectionStatus;
  accepts(generation: number): boolean;
  /** The owner is only usable with a generation accepted by accepts(). */
  currentOwner(generation?: number): ProviderOwner | null;
  close(): Promise<void>;
}

const failure = (code: string): Error => new Error(code);

function cancellation(): Error { return failure('OBSERVER_PROVIDER_SELECTION_CANCELLED'); }
function cleanupFailure(): Error { return failure('OBSERVER_PROVIDER_SELECTION_CLEANUP_FAILED'); }

/**
 * Generation-bound owner replacement. A generation is invalid as soon as a
 * switch starts, so late observer results cannot reach a newly selected HUD.
 * The old owner is drained before open() is called and is never reinstated.
 */
export function createProviderSelection({open, persist}: ProviderSelectionOptions): ProviderSelection {
  let generation = 0;
  let state: ProviderSelectionState = 'inactive';
  let owner: ProviderOwner | null = null;
  let mutation: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let switchController: AbortController | undefined;

  const snapshot = (): ProviderSelectionStatus => ({generation, state});
  const invalidate = (next: ProviderSelectionState): void => {
    generation += 1;
    state = next;
  };

  async function closeOwner(value: ProviderOwner | null): Promise<void> {
    if (value === null) return;
    await value.close();
  }

  async function select(config: ProviderConfig, signal: AbortSignal): Promise<void> {
    if (closed) throw failure('OBSERVER_PROVIDER_SELECTION_CLOSED');
    if (mutation !== undefined) throw failure('OBSERVER_PROVIDER_SELECTION_BUSY');
    if (owner !== null && state === 'failed') throw failure('OBSERVER_PROVIDER_SELECTION_CLEANUP_REQUIRED');
    if (signal.aborted) {
      invalidate('inactive');
      throw cancellation();
    }
    const switchGeneration = generation + 1;
    generation = switchGeneration;
    state = 'switching';
    const controller = new AbortController();
    switchController = controller;
    const combined = AbortSignal.any([signal, controller.signal]);
    const operation = (async () => {
      const old = owner;
      try {
        if (combined.aborted) throw cancellation();
        try { await closeOwner(old); }
        catch { throw cleanupFailure(); }
        owner = null;
        if (combined.aborted) throw cancellation();

        // Do not race open() against abort: a late owner must be retained and
        // closed before this mutation settles, otherwise a later select can
        // overlap its still-live provider.
        let next: ProviderOwner;
        try { next = await Promise.resolve().then(() => open(config, combined)); }
        catch (error) { if (combined.aborted) throw cancellation(); throw error; }
        owner = next;
        try {
          if (combined.aborted) throw cancellation();
          await (next.inspectSelection?next.inspectSelection(combined):next.inspect(combined));
          if (combined.aborted) throw cancellation();
          await persist(config);
          if (combined.aborted) throw cancellation();
          state = 'ready';
        } catch (error) {
          try {
            await closeOwner(next);
            if (owner === next) owner = null;
          } catch {
            // Keep owner for close() retry; the source is not safely reusable.
            throw cleanupFailure();
          }
          throw error;
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'OBSERVER_PROVIDER_SELECTION_CANCELLED') {
          state = 'inactive';
          throw cancellation();
        }
        state = 'failed';
        throw failure('OBSERVER_PROVIDER_SELECTION_FAILED');
      } finally {
        if (switchController === controller) switchController = undefined;
      }
    })();
    mutation = operation;
    try { await operation; }
    finally { if (mutation === operation) mutation = undefined; }
  }

  async function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    generation += 1;
    state = 'inactive';
    switchController?.abort();
    closing = (async () => {
      await mutation?.catch(() => undefined);
      const current = owner;
      try {
        await closeOwner(current);
        if (owner === current) owner = null;
      } catch {
        state = 'failed';
        throw failure('OBSERVER_PROVIDER_SELECTION_CLOSE_FAILED');
      }
    })().finally(() => { closing = undefined; });
    return closing;
  }

  return {
    select,
    status: snapshot,
    accepts(value: number): boolean { return !closed && state === 'ready' && value === generation && owner !== null; },
    currentOwner(value?: number): ProviderOwner | null {
      const requested = value ?? generation;
      return !closed && state === 'ready' && requested === generation ? owner : null;
    },
    close,
  };
}
