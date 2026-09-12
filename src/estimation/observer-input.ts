import {observerInputSchema} from './observer-contract.js';
import {extractPassiveContent} from '../hooks/passive-content.js';
import {retainObserverInput,noteObserverDrop,noteObserverOmission} from './observer-retention.js';

/** Version of the local facts assembly and bounded-retention implementation. */
export const OBSERVER_INPUT_FACTS_VERSION='observer-input-facts-v3';

/** The packet is private stdin, not a diagnostic or public snapshot. Filter before
 * any clipping; this is basic credential filtering, not a full DLP guarantee.
 */
export function packObserverInput(input: unknown): string {
  const parsed = observerInputSchema.safeParse(input);
  if (!parsed.success) throw new Error('INVALID_OBSERVER_INPUT');
  const packet = parsed.data;
  const filtered = (text: string) => extractPassiveContent('Stop', {last_assistant_message: text});
  if (packet.observation?.currentAction) {
    const action = packet.observation.currentAction;
    const original=action.text;
    const result = filtered(action.text);
    if (!result?.text) packet.observation.currentAction = null;
    else action.text = result.text.slice(0, 2048).replace(/[\uD800-\uDBFF]$/u, '');
    if (!result?.text || result.truncated || action.text!==original) {
      noteObserverOmission(packet,'tool');
    }
  }
  if (packet.goalSummary !== null) {
    const original=packet.goalSummary;
    const result = filtered(packet.goalSummary);
    const text = result?.text ?? '';
    packet.goalSummary = text.slice(0, 2048).replace(/[\uD800-\uDBFF]$/u, '') || null;
    if (!result?.text || result.truncated || packet.goalSummary!==original) noteObserverOmission(packet,'summary');
  }
  packet.messages = packet.messages.flatMap(message => {
    const result = filtered(message.text);
    if (!result?.text) {noteObserverDrop(packet,message); return [];}
    const changed=result.truncated||result.text!==message.text;
    if (changed) noteObserverOmission(packet,message.kind);
    return [{...message, text: result.text, truncated: message.truncated || changed}];
  });
  if (!packet.messages.length) throw new Error('INVALID_OBSERVER_INPUT');
  retainObserverInput(packet);
  if (!observerInputSchema.safeParse(packet).success) throw new Error('INVALID_OBSERVER_INPUT');
  return JSON.stringify(packet);
}
