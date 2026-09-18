import type {Invocation} from './owned-process.js';
import type {createObserverSessionProcess} from './observer-session-process.js';
import type {createMainAccountLease} from './main-account-lease.js';

/** Request-scoped, initialized transport. Its caller owns the process and lease;
 * metadata attestation borrows them, never transfers their cleanup authority. */
export type MainAccountSessionTransport = Awaited<ReturnType<ReturnType<typeof createObserverSessionProcess>['start']>> & {
 invocation:Invocation;
 lease:ReturnType<typeof createMainAccountLease>;
};
export type OpenMainAccountSession=(invocation:Invocation,signal:AbortSignal)=>Promise<MainAccountSessionTransport>;
