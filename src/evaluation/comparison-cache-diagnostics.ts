type Strategy='seed'|'history'|'native';
type Row={strategy:Strategy;hitCount:number;missCount:number;localGuardCount:number;localGuardMs:number};
/** Diagnostic evidence only: bounded allowlisted numbers, never raw identity data. */
export function createComparisonCacheDiagnostics(){
 const rows:Row[]=[];
 return {
  record(strategy:Strategy,value:unknown){
   if(rows.length>=128||!['seed','history','native'].includes(strategy)||!value||typeof value!=='object')return;
   const v=value as Record<string,unknown>;
   const {hitCount,missCount,localGuardCount,localGuardMs}=v;
   if(![hitCount,missCount,localGuardCount].every(n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0)||
    typeof localGuardMs!=='number'||!Number.isFinite(localGuardMs)||localGuardMs<0)return;
   rows.push({strategy,hitCount:hitCount as number,missCount:missCount as number,localGuardCount:localGuardCount as number,localGuardMs});
  },
  snapshot:()=>rows.map(row=>({...row})),
 };
}
