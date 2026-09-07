/** Trusted host errors only. Model text and generic exception messages cannot grant retries. */
export class ObserverAccountTimeout extends Error {
  constructor(){super('OBSERVER_ACCOUNT_READ_FAILED');}
}
export class ObserverPreDispatchTransient extends Error {
  constructor(){super('OBSERVER_PRE_DISPATCH_TRANSIENT');}
}
