import type {NativeSourceSnapshot} from './native-source-snapshot.js';
import type {NativeTurnBoundary} from './native-turn-boundary.js';
import type {HistorySnapshot} from './history-snapshot.js';

/** Internal worker-owned destination. Never populated from chat or HTTP data. */
export interface NativeSourceDestination {
 sourceProfile?:'codex-01534-legacy';
 destinationDirectory:string;
 maxSourceBytes:number;
 verifyDestination:()=>Promise<void>;
 beforeCopy?:(path:string)=>Promise<void>;
 copySettled?:()=>void;
}
export interface OpenNativeSourceResult {snapshot:NativeSourceSnapshot;currentTurnId:string}

/** Local-only paired source capture. Base custody transfers only when openBase
 * returns successfully; close() retires source readers, not that owned copy. */
export interface NativeTurnSource {
 identity:string;sourceEpoch:number;revision:number;currentTurnId:string;
 boundary:NativeTurnBoundary;baseKey:string;supplement:HistorySnapshot;
 openBase(destination:NativeSourceDestination,signal:AbortSignal):Promise<NativeSourceSnapshot|null>;
 validate(signal:AbortSignal):Promise<void>;
 close():Promise<void>;
}

/** Local scalar state sampled after preparation; no history or source paths. */
export interface NativeObservationSample {activeSeconds:number;runtime:'running';requestActiveSeconds:number}
