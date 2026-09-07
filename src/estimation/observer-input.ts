import {observerInputSchema} from './observer-contract.js';
import {extractPassiveContent} from '../hooks/passive-content.js';

const MAX_INPUT_BYTES = 16384;

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
    const result = filtered(action.text);
    if (!result?.text) packet.observation.currentAction = null;
    else action.text = result.text.slice(0, 2048).replace(/[\uD800-\uDBFF]$/u, '');
    if (!result?.text || result.truncated) {
      packet.truncated = true;
      if (!packet.observation.omittedCategories.includes('tool')) packet.observation.omittedCategories.push('tool');
    }
  }
  if (packet.goalSummary !== null) {
    const result = filtered(packet.goalSummary);
    const text = result?.text ?? '';
    packet.goalSummary = text.slice(0, 2048).replace(/[\uD800-\uDBFF]$/u, '') || null;
    if (result?.truncated || text.length > 2048) packet.truncated = true;
  }
  packet.messages = packet.messages.flatMap(message => {
    const result = filtered(message.text);
    if (!result?.text) {packet.truncated = true; return [];}
    if (result.truncated) packet.truncated = true;
    return [{...message, text: result.text, truncated: message.truncated || result.truncated}];
  });
  if (!packet.messages.length) throw new Error('INVALID_OBSERVER_INPUT');
  const lastUser = [...packet.messages].reverse().find(message => message.kind === 'user');
  const lastAssistant = [...packet.messages].reverse().find(message => message.kind === 'assistant');
  const originals = new Map(packet.messages.map(message => [message, Array.from(message.text)]));
  const lengths = new Map([...originals].map(([message, points]) => [message, points.length]));
  let encoded = JSON.stringify(packet);
  while (Buffer.byteLength(encoded, 'utf8') > MAX_INPUT_BYTES) {
    packet.truncated = true;
    const removable = packet.messages.findIndex(message => message !== lastUser && message !== lastAssistant);
    if (removable >= 0 && packet.messages.length > 1) packet.messages.splice(removable, 1);
    else {
      const candidate = [...packet.messages].filter(message => lengths.get(message)! > 32)
        .sort((left, right) => Buffer.byteLength(right.text) - Buffer.byteLength(left.text))[0];
      if (!candidate) throw new Error('INVALID_OBSERVER_INPUT');
      const length = Math.max(32, Math.floor(lengths.get(candidate)! * 0.75));
      lengths.set(candidate, length);
      const points = originals.get(candidate)!;
      candidate.text = points.slice(0, Math.ceil(length / 2)).join('') + '\n[…]\n' +
        points.slice(-Math.floor(length / 2)).join('');
      candidate.truncated = true;
    }
    encoded = JSON.stringify(packet);
  }
  if (!observerInputSchema.safeParse(packet).success) throw new Error('INVALID_OBSERVER_INPUT');
  return encoded;
}
