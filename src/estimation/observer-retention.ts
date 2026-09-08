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

/** Shared deterministic selection after filtering; metadata participates in byte budget. */
export function retainObserverInput(packet:ObserverInput):ObserverInput {
  const messages=packet.messages;
  const firstUser=messages.find(m=>m.kind==='user');
  const lastUser=[...messages].reverse().find(m=>m.kind==='user');
  const lastAssistant=[...messages].reverse().find(m=>m.kind==='assistant');
  const protectedMessages=new Set([firstUser,lastUser,lastAssistant]);
  const encode=()=>{refresh(packet);return JSON.stringify(packet);};
  while(Buffer.byteLength(encode(),'utf8')>16384||messages.length>128||
    messages.reduce((n,m)=>n+m.text.length,0)>65536){
    if(packet.paceMeasurements&&packet.paceMeasurements.length>0){
      const index=packet.paceMeasurements.reduce((selected,current,index,array)=>
        current.sampleCount<array[selected]!.sampleCount?index:selected,0);
      packet.paceMeasurements.splice(index,1);
      noteObserverOmission(packet,'summary');
      continue;
    }
    // Preserve amendments ahead of tool logs and old assistant statements.
    let index=messages.findIndex(m=>m.kind==='tool');
    if(index<0)index=messages.findIndex(m=>m.kind==='assistant'&&!protectedMessages.has(m));
    if(index<0)index=messages.findIndex(m=>!protectedMessages.has(m));
    if(index>=0&&messages.length>1){
      const removed=messages.splice(index,1)[0]!;
      noteObserverDrop(packet,removed);continue;
    }
    const candidate=[...messages].sort((a,b)=>b.text.length-a.text.length).find(m=>Array.from(m.text).length>32);
    if(!candidate)throw Error('CONTEXT_LIMIT');
    const chars=Array.from(candidate.text),size=Math.max(8,Math.floor(chars.length/3));
    candidate.text=chars.slice(0,size).join('')+'\n[…]\n'+chars.slice(-size).join('');
    candidate.truncated=true;noteObserverOmission(packet,candidate.kind);
  }
  refresh(packet);
  return packet;
}
