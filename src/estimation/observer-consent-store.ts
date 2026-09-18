import {randomBytes} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {z} from 'zod';

export const OBSERVER_CONSENT_VERSION = 1 as const;
export interface ObserverSubscriptionConsentScope {
  accountPolicy?: 'main-follow-v1' | undefined;
  accountFingerprint: string;
  providerFingerprint: string;
  recipientFingerprint: string;
  dataCategories: readonly string[];
  billingMode: 'subscription';
  policyVersion: string;
}
export interface ObserverApiConsentScope {
  bindingVersion: 1;
  accountFingerprint: string;
  providerFingerprint: string;
  recipientFingerprint: string;
  profileId: string;
  keyRevision: string;
  endpointFingerprint: string;
  dataCategories: readonly string[];
  billingMode: 'api';
  policyVersion: string;
}
export type ObserverConsentScope = ObserverSubscriptionConsentScope | ObserverApiConsentScope;
export interface ObserverConsentGrant {
  version: typeof OBSERVER_CONSENT_VERSION;
  scope: ObserverConsentScope;
  grantedAt: number;
}

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const subscriptionScopeSchema = z.object({
  accountPolicy: z.literal('main-follow-v1').optional(),
  accountFingerprint: fingerprint,
  providerFingerprint: fingerprint,
  recipientFingerprint: fingerprint,
  dataCategories: z.array(z.string().min(1).max(64)).min(1).max(16),
  billingMode: z.literal('subscription'),
  policyVersion: z.string().regex(/^[a-z0-9-]{1,64}$/),
}).strict();
const apiScopeSchema = z.object({
  bindingVersion: z.literal(1),
  accountFingerprint: fingerprint,
  providerFingerprint: fingerprint,
  recipientFingerprint: fingerprint,
  profileId: z.string().min(1).max(128).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value)),
  keyRevision: z.string().min(1).max(256).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value)),
  endpointFingerprint: fingerprint,
  dataCategories: z.array(z.string().min(1).max(64)).min(1).max(16),
  billingMode: z.literal('api'),
  policyVersion: z.string().regex(/^[a-z0-9-]{1,64}$/),
}).strict();
const scopeSchema = z.union([subscriptionScopeSchema, apiScopeSchema]);
const grantSchema = z.object({version: z.literal(OBSERVER_CONSENT_VERSION), scope: scopeSchema, grantedAt: z.number().int().nonnegative().safe()}).strict();

export interface ConsentProtection {
  protect(value: string): Promise<string> | string;
  unprotect(value: string): Promise<string | null> | string | null;
}

function canonicalScope(scope: ObserverConsentScope): string {
  const normalized = {...scope, dataCategories: [...scope.dataCategories].sort()};
  return JSON.stringify(Object.fromEntries(Object.keys(normalized).sort().map(key => [key, normalized[key as keyof typeof normalized]])));
}

export function createObserverConsentStore(path: string, protection: ConsentProtection) {
  let cached: ObserverConsentGrant | null | undefined;
  async function read(): Promise<ObserverConsentGrant | null> {
    if (cached !== undefined) return cached;
    let sealed: string;
    try { sealed = await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (cached = null); throw new Error('OBSERVER_CONSENT_STORAGE_UNAVAILABLE'); }
    try {
      const raw = await protection.unprotect(sealed);
      if (!raw || Buffer.byteLength(raw, 'utf8') > 16 * 1024) return (cached = null);
      const parsed = grantSchema.safeParse(JSON.parse(raw));
      return (cached = parsed.success ? Object.freeze({...parsed.data, scope: Object.freeze({...parsed.data.scope, dataCategories: Object.freeze([...parsed.data.scope.dataCategories].sort())})}) : null);
    } catch { return (cached = null); }
  }
  return {
    read,
    async grant(scope: ObserverConsentScope, grantedAt: number): Promise<void> {
      const parsed = grantSchema.safeParse({version: OBSERVER_CONSENT_VERSION, scope: {...scope, dataCategories: [...scope.dataCategories].sort()}, grantedAt});
      if (!parsed.success) throw new Error('OBSERVER_CONSENT_INVALID');
      const sealed = await protection.protect(JSON.stringify(parsed.data));
      if (typeof sealed !== 'string' || Buffer.byteLength(sealed, 'utf8') > 32 * 1024) throw new Error('OBSERVER_CONSENT_INVALID');
      await mkdir(dirname(path), {recursive: true, mode: 0o700});
      const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
      try { await writeFile(temporary, sealed, {encoding: 'utf8', mode: 0o600}); await rename(temporary, path); }
      finally { await rm(temporary, {force: true}).catch(() => undefined); }
      cached = Object.freeze({...parsed.data, scope: Object.freeze({...parsed.data.scope, dataCategories: Object.freeze([...parsed.data.scope.dataCategories])})});
    },
    async revoke(): Promise<void> {
      await rm(path, {force: true});
      cached = null;
    },
    matches(scope: ObserverConsentScope): boolean {
      return cached !== undefined && cached !== null && canonicalScope(cached.scope) === canonicalScope(scope);
    },
  };
}

export type ObserverConsentStore = ReturnType<typeof createObserverConsentStore>;
