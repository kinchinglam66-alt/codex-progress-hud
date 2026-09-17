import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';

const incidentSchema=z.object({
 ownerUuid:z.string().uuid(),conversationKey:z.string().min(1).max(512),
 generation:z.number().int().nonnegative().safe(),at:z.number().int().nonnegative().safe(),
 pid:z.number().int().positive().safe(),creationIdentity:z.string().min(1).max(256),
 reason:z.enum(['turn/started','turn/completed','item/started','item/completed','thread/tokenUsage/updated']),
}).strict();
export type UnexpectedModelWork=z.infer<typeof incidentSchema>;
export type UnexpectedModelOwner=Pick<UnexpectedModelWork,'ownerUuid'|'pid'|'creationIdentity'>;

/** Observed protocol violation, never an admission. At most one unresolved
 * usage incident per poisoned owner; notification bursts must not multiply it.
 * Caller owns the database transaction and execution/recovery fences. */
export function createUnexpectedModelWorkStore(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS unexpected_model_work_totals (
  id INTEGER PRIMARY KEY CHECK(id=1), archived_count INTEGER NOT NULL, retired_through INTEGER NOT NULL
 ); INSERT OR IGNORE INTO unexpected_model_work_totals VALUES(1,0,-1)`);
 const totals=()=>{
  const rows=db.prepare('SELECT * FROM unexpected_model_work_totals').all();
  if(rows.length!==1||rows[0]!.id!==1||Object.keys(rows[0]!).length!==3)throw Error('UNEXPECTED_WORK_SCHEMA_INVALID');
  return {archived:z.number().int().nonnegative().safe().parse(rows[0]!.archived_count),
   retired:z.number().int().min(-1).safe().parse(rows[0]!.retired_through)};
 };
 totals();
 db.exec(`CREATE TABLE IF NOT EXISTS unexpected_model_work (
  owner_uuid TEXT PRIMARY KEY, conversation TEXT NOT NULL,
  generation INTEGER NOT NULL, observed_at INTEGER NOT NULL, reason TEXT NOT NULL,
  pid INTEGER NOT NULL, creation_identity TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN(0,1))
 )`);
 const columns=db.prepare('PRAGMA table_info(unexpected_model_work)').all().map(row=>row.name);
 if(columns.length!==8||!['owner_uuid','conversation','generation','observed_at','reason','pid','creation_identity','closed'].every(c=>columns.includes(c)))throw Error('UNEXPECTED_WORK_SCHEMA_INVALID');
 const decode=(row:Record<string,unknown>)=>{
  if(row.closed!==0&&row.closed!==1)throw Error('UNEXPECTED_WORK_SCHEMA_INVALID');
  return incidentSchema.parse({ownerUuid:row.owner_uuid,conversationKey:row.conversation,generation:row.generation,at:row.observed_at,reason:row.reason,pid:row.pid,creationIdentity:row.creation_identity});
 };
 const rows=db.prepare('SELECT * FROM unexpected_model_work LIMIT 4097').all();
 if(rows.length>4096)throw Error('UNEXPECTED_WORK_LIMIT');
 for(const row of rows)decode(row);
 const detailCount=()=>Number(db.prepare('SELECT COUNT(*) AS count FROM unexpected_model_work').get()!.count);
 const count=()=>z.number().int().nonnegative().safe().parse(totals().archived+detailCount());
 const compactClosed=()=>{
  const retired=db.prepare('SELECT owner_uuid,observed_at FROM unexpected_model_work WHERE closed=1 ORDER BY observed_at DESC,owner_uuid DESC LIMIT -1 OFFSET 128').all();
  if(!retired.length)return;
  const previous=totals(),archived=z.number().int().nonnegative().safe().parse(previous.archived+retired.length);
  const through=Math.max(previous.retired,...retired.map(row=>Number(row.observed_at)));
  db.exec('SAVEPOINT unexpected_work_compact');
  try{
   db.prepare('UPDATE unexpected_model_work_totals SET archived_count=?,retired_through=? WHERE id=1').run(archived,through);
   for(const row of retired)db.prepare('DELETE FROM unexpected_model_work WHERE owner_uuid=? AND closed=1').run(row.owner_uuid!);
   db.exec('RELEASE unexpected_work_compact');
  }catch(error){db.exec('ROLLBACK TO unexpected_work_compact; RELEASE unexpected_work_compact');throw error;}
 };
 compactClosed();
 return {
  count,
  pending:()=>db.prepare('SELECT * FROM unexpected_model_work WHERE closed=0').all().map(decode),
  confirmExit(owner:UnexpectedModelOwner){
   const previous=db.prepare('SELECT * FROM unexpected_model_work WHERE owner_uuid=?').get(owner.ownerUuid);
   if(!previous)throw Error('UNEXPECTED_WORK_OWNER_MISSING');
   const value=decode(previous);
   if(value.pid!==owner.pid||value.creationIdentity!==owner.creationIdentity)throw Error('UNEXPECTED_WORK_OWNER_MISMATCH');
   db.prepare('UPDATE unexpected_model_work SET closed=1 WHERE owner_uuid=?').run(owner.ownerUuid);
   compactClosed();
  },
  record(input:UnexpectedModelWork){
   const value=incidentSchema.parse(input);
   const previous=db.prepare('SELECT * FROM unexpected_model_work WHERE owner_uuid=?').get(value.ownerUuid);
   if(previous){
    const old=decode(previous);
    if(old.conversationKey!==value.conversationKey||old.generation!==value.generation||old.pid!==value.pid||old.creationIdentity!==value.creationIdentity)throw Error('UNEXPECTED_WORK_OWNER_MISMATCH');
    return;
   }
   // Old discarded owner IDs cannot be replayed into a second unknown count.
   // An existing unresolved owner is matched above even behind this watermark.
   if(value.at<=totals().retired)throw Error('UNEXPECTED_WORK_RETIRED_EVENT');
   if(detailCount()>=4096)throw Error('UNEXPECTED_WORK_LIMIT');
   db.prepare('INSERT INTO unexpected_model_work(owner_uuid,conversation,generation,observed_at,reason,pid,creation_identity) VALUES(?,?,?,?,?,?,?)')
    .run(value.ownerUuid,value.conversationKey,value.generation,value.at,value.reason,value.pid,value.creationIdentity);
  },
 };
}
