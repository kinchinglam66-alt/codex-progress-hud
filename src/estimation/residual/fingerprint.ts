import {createHash} from 'node:crypto';
import type {ConversationRecord} from '../../observer/conversation-record.js';
export function researchTurnId(r:ConversationRecord):string|null {
  return r.sourceTurnId===undefined?r.turnId:r.sourceTurnId;
}
/** Same projection for request tickets and full-history scans; never stored raw. */
export function createPrefixFingerprint(){
  const hash=createHash('sha256');
  return {add(r:ConversationRecord){const turnId=researchTurnId(r);if(turnId===null)return;
    hash.update(JSON.stringify([r.id,turnId,r.kind,r.atMs,r.actionId??null,r.complete??null,r.exitCode??null])+'\n');},finish:()=>hash.digest('hex')};
}
