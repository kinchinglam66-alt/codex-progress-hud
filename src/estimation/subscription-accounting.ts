/** Execution-facing accounting contract. Implementations own durable admission.
 * Null settlement means unknown usage, never a free or unlaunched call.
 */
export interface AccountedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
}

export interface SubscriptionAccounting {
  reserve(): Promise<string | null>;
  settle(id: string, usage: AccountedUsage | null): Promise<void>;
  /** Trusted caller proves no model dispatch. Retains the start; never clears recovered uncertainty. */
  cancelBeforeDispatch(id:string):Promise<void>;
  close(): Promise<void>;
}
