export interface ContextCapacity {
  contextTokens:number;
  outputReserveTokens:number;
  requestBytes:number|null;
  source:'provider'|'configured';
}

export interface RequestSizer {
  kind:'tokenizer'|'conservative';
  count(serializedRequest:string):number;
}

function isSafePositiveInteger(value:unknown):value is number {
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
}

function validateCapacity(capacity:ContextCapacity):void {
  if(capacity===null||typeof capacity!=='object')throw new TypeError('capacity must be an object');
  if(!isSafePositiveInteger(capacity.contextTokens))throw new RangeError('contextTokens must be a safe positive integer');
  if(typeof capacity.outputReserveTokens!=='number'||!Number.isSafeInteger(capacity.outputReserveTokens)||
    capacity.outputReserveTokens<0||capacity.outputReserveTokens>=capacity.contextTokens){
    throw new RangeError('outputReserveTokens must be a nonnegative safe integer smaller than contextTokens');
  }
  if(capacity.requestBytes!==null&& !isSafePositiveInteger(capacity.requestBytes)){
    throw new RangeError('requestBytes must be null or a safe positive integer');
  }
  if(capacity.source!=='provider'&&capacity.source!=='configured')throw new TypeError('capacity source is invalid');
}

function validateSizer(sizer:RequestSizer):void {
  if(sizer===null||typeof sizer!=='object')throw new TypeError('sizer must be an object');
  if(sizer.kind!=='tokenizer'&&sizer.kind!=='conservative')throw new TypeError('sizer kind is invalid');
  if(typeof sizer.count!=='function')throw new TypeError('sizer count must be a function');
}

export function requestFits(serializedRequest:string,capacity:ContextCapacity,sizer:RequestSizer):boolean {
  if(typeof serializedRequest!=='string')throw new TypeError('serializedRequest must be a string');
  validateCapacity(capacity);
  validateSizer(sizer);
  const tokenCount=sizer.count(serializedRequest);
  if(!Number.isSafeInteger(tokenCount)||tokenCount<0)throw new RangeError('sizer count must be a nonnegative safe integer');
  const tokenFits=tokenCount<=capacity.contextTokens-capacity.outputReserveTokens;
  const byteFits=capacity.requestBytes===null||Buffer.byteLength(serializedRequest,'utf8')<=capacity.requestBytes;
  return tokenFits&&byteFits;
}
