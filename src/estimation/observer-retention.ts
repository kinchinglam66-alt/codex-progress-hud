import type {ObserverInput} from './observer-contract.js';

type Message=ObserverInput['messages'][number];

/** Mutates only an owned packet. Counts cover this snapshot, not upstream history. */
export function noteObserverDrop(packet:ObserverInput,message:Message):void {
  packet.truncated=true;
  if(packet.packingLoss)packet.packingLoss.droppedByKind[message.kind]++;
  noteObserverOmission(packet,message.kind);
}

export function noteObserverOmission(packet:ObserverInput,kind:Message['kind']|'summary'):void {
  packet.truncated=true;
  const omitted=packet.observation?.omittedCategories;
  if(omitted&&!omitted.includes(kind))omitted.push(kind);
}

function refresh(packet:ObserverInput):void {
  if(packet.packingLoss){
    packet.packingLoss.retainedMessages=packet.messages.length;
    packet.packingLoss.clippedMessages=packet.messages.filter(m=>m.truncated).length;
  }
  const pairs=new Map<number,Set<string>>();
  for(const {event} of packet.messages){
    if(event?.pairOrdinal===undefined)continue;
    const kinds=pairs.get(event.pairOrdinal)??new Set<string>();
    kinds.add(event.kind);pairs.set(event.pairOrdinal,kinds);
  }
  for(const {event} of packet.messages){
    if(event?.kind!=='tool_start'&&event?.kind!=='tool_result')continue;
    const kinds=event.pairOrdinal===undefined?undefined:pairs.get(event.pairOrdinal);
    event.counterpartMissing=!(kinds?.has('tool_start')&&kinds.has('tool_result'));
  }
}

/** Refresh pairing and packing metadata on an owned packet. Text and evidence
 * selection belong to source preparation/capacity layers, not this legacy API. */
export function retainObserverInput(packet:ObserverInput):ObserverInput {
  refresh(packet);
  return packet;
}
