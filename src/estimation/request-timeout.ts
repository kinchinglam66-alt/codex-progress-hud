/** Zero disables the optional end-to-end ETA deadline, not transport/cleanup guards. */
export function parseEstimateTimeoutMs(value:string|undefined):number {
  if(value===undefined||value.trim()==='')return 0;
  if(!/^\d+$/.test(value))throw Error('INVALID_ESTIMATE_TIMEOUT');
  const ms=Number(value);
  if(!Number.isSafeInteger(ms)||ms>2_147_483_647)throw Error('INVALID_ESTIMATE_TIMEOUT');
  return ms;
}
