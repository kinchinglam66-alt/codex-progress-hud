import {observerInputSchema} from './observer-contract.js';
import {retainObserverInput} from './observer-retention.js';

/** Version of lossless readable-history assembly and capacity preparation. */
export const OBSERVER_INPUT_FACTS_VERSION='observer-input-facts-v7';

/** The packet is private estimator input. Task text is intentionally lossless;
 * diagnostics and public snapshots have separate privacy contracts. */
export function packObserverInput(input: unknown): string {
  const parsed = observerInputSchema.safeParse(input);
  if (!parsed.success) throw new Error('INVALID_OBSERVER_INPUT');
  const packet = parsed.data;
  retainObserverInput(packet);
  if (!observerInputSchema.safeParse(packet).success) throw new Error('INVALID_OBSERVER_INPUT');
  return JSON.stringify(packet);
}
