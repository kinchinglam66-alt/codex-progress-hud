import {createHash} from 'node:crypto';
import {z} from 'zod';
const route=z.object({
  model_provider:z.literal('openai'),
  forced_login_method:z.literal('chatgpt'),
  cli_auth_credentials_store:z.literal('file'),
  chatgpt_base_url:z.literal('https://chatgpt.com/backend-api/'),
  model_providers:z.record(z.string(),z.unknown()).refine(value=>Object.keys(value).length===0),
});
/** Consumes actual isolated config/read output, never model/task assertions.
 * Fingerprints only this route subset, not account/assets, system policy or
 * subsequent process identity. Other activation evidence is still required. */
export function observerRouteFingerprint(config:unknown):string {
  try {
    const parsed=route.parse(config);
    return createHash('sha256').update('observer-subscription-route-v1\n'+JSON.stringify(parsed)).digest('hex');
  } catch {throw Error('OBSERVER_ROUTE_UNVERIFIED');}
}
