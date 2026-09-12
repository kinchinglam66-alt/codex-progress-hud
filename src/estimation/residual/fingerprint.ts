import {createHash} from 'node:crypto';
import type {ConversationRecord} from '../../observer/conversation-record.js';
/** Same projection for request tickets and full-history scans; never stored raw. */
export function createPrefixFingerprint(){
  const hash=createHash('sha256');
  return {add(r:ConversationRecord){hash.update(JSON.stringify([r.id,r.turnId,r.kind,r.atMs,r.actionId??null,r.complete??null,r.exitCode??null])+'\n');},finish:()=>hash.digest('hex')};
}
