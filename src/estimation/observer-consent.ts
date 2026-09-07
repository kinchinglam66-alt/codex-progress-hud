import {z} from 'zod';

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceSchema = z.object({
  accountFingerprint: fingerprint,
  routeFingerprint: fingerprint,
  assetsFingerprint: fingerprint,
  observedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().nonnegative().safe(),
}).strict().refine(value => value.expiresAt > value.observedAt && value.expiresAt - value.observedAt <= 300000);
export type ObserverAttestation = z.infer<typeof evidenceSchema>;

/** Host-private authorization state only. Valid metadata is not proof of an
 * account or a user's consent; trusted attestation/UI sources must supply both.
 * Starts unapproved on every construction; no automatic persisted grant restore. */
export function createObserverConsentGate(options: {now: () => number; onInvalidate: () => void}) {
  let evidence: ObserverAttestation | null = null;
  let approved = false, poisoned = false, notifying = false;
  let lastClock = 0;
  let outstanding: {token: object; binding: string; expiresAt: number} | null = null;
  const binding = (value: ObserverAttestation) => `${value.accountFingerprint}:${value.routeFingerprint}:${value.assetsFingerprint}`;
  function invalidate(): void {
    const wasApproved = approved;
    approved = false; evidence = null; outstanding = null;
    if (!wasApproved || notifying) return;
    notifying = true;
    try {options.onInvalidate();}
    catch {poisoned = true;}
    finally {notifying = false;}
  }
  function time(): number | null {
    if (poisoned || notifying) return null;
    try {
      const now = options.now();
      if (!Number.isSafeInteger(now) || now < lastClock) throw Error();
      lastClock = now;
      return now;
    } catch {poisoned = true; invalidate(); return null;}
  }
  function fresh(): number | null {
    const now = time();
    if (now === null) return null;
    if (evidence && (now < evidence.observedAt || now >= evidence.expiresAt)) invalidate();
    return evidence ? now : null;
  }
  return {
    update(input: unknown): void {
      if (notifying) return;
      const now = time();
      if (now === null) return;
      const parsed = evidenceSchema.safeParse(input);
      if (!parsed.success || parsed.data.observedAt > now || parsed.data.expiresAt <= now) {invalidate(); return;}
      if (evidence && (now >= evidence.expiresAt || binding(evidence) !== binding(parsed.data))) invalidate();
      if (!poisoned) evidence = Object.freeze(parsed.data);
    },
    offer(): object | null {
      if (fresh() === null || !evidence) return null;
      const token = Object.freeze({});
      outstanding = {token, binding: binding(evidence), expiresAt: evidence.expiresAt};
      return token;
    },
    accept(token: object): boolean {
      const now = fresh();
      if (now === null || !evidence || !outstanding || token !== outstanding.token ||
          now >= outstanding.expiresAt || outstanding.binding !== binding(evidence)) return false;
      outstanding = null; approved = true;
      return true;
    },
    revoke(): void {invalidate();},
    authorized(): boolean {return fresh() !== null && approved;},
  };
}
