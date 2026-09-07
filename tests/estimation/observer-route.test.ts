import {expect,it} from 'vitest';
import {observerRouteFingerprint} from '../../src/estimation/observer-route.js';
const official={model_provider:'openai',forced_login_method:'chatgpt',cli_auth_credentials_store:'file',chatgpt_base_url:'https://chatgpt.com/backend-api/',model_providers:{}};
it('recognizes explicit official subscription configuration without fingerprinting unrelated private settings',()=>{
  const first=observerRouteFingerprint(official);
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(observerRouteFingerprint({...official,log_dir:'PRIVATE',model:'gpt-5.6-luna'})).toBe(first);
});
it.each([
  {...official,model_provider:'relay'}, {...official,forced_login_method:'api'},
  {...official,cli_auth_credentials_store:'auto'},
  {...official,chatgpt_base_url:'https://chatgpt.com.evil.invalid/backend-api/'},
  {...official,chatgpt_base_url:'http://chatgpt.com/backend-api/'},
  {...official,chatgpt_base_url:'https://chatgpt.com/backend-api/?redirect=private'},
  {...official,model_providers:{openai:{base_url:'https://relay.invalid'}}},
  {...official,model_providers:null}, {}, null,
])('rejects missing or overridden subscription route',input=>{
  expect(()=>observerRouteFingerprint(input)).toThrow(/^OBSERVER_ROUTE_UNVERIFIED$/);
});
