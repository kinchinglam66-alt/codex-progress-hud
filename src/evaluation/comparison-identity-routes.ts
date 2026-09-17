type Strategy='history'|'native';
type Policy={accountCache:'allow'|'bypass'};
interface Identity<T>{
 prepareSession(signal:AbortSignal,policy:Policy):Promise<T>;
 invalidateSessionReuse():void;
 close():Promise<void>;
}
/** Diagnostic identities only; never shares an opt-in cache between strategies
 * or uses seed/preflight work to warm either strategy. */
export function createComparisonIdentityRoutes<T>(options:{enabled:boolean;seed:Identity<T>;create:(strategy:Strategy)=>Identity<T>}){
 const identities=new Map<Strategy,Identity<T>>();
 function identity(strategy?:Strategy):Identity<T>{
  if(strategy!==undefined&&strategy!=='history'&&strategy!=='native')throw Error('TRIAL_STRATEGY_INVALID');
  if(!options.enabled||strategy===undefined)return options.seed;
  let value=identities.get(strategy);
  if(!value){value=options.create(strategy);identities.set(strategy,value);}
  return value;
 }
 return {
  identity,
  prepare(signal:AbortSignal,strategy?:Strategy,policy?:Policy){
   signal.throwIfAborted();
   return identity(strategy).prepareSession(signal,{accountCache:options.enabled&&strategy!==undefined&&policy?.accountCache!=='bypass'?'allow':'bypass'});
  },
  owners:()=>Array.from(identities,([name,value])=>({name:`identity-${name}`,close:()=>value.close()})),
 };
}
