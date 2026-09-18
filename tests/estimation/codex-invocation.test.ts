import { resolve } from "node:path";
import { expect, it } from "vitest";
import { buildCodexInvocation, buildObserverCodexInvocation, buildObserverCompressionInvocation, buildObserverSetupInvocation, buildObserverExternalInvocation } from "../../src/estimation/codex-invocation.js";

const features = ["plugins", "hooks", "apps", "remote_plugin", "multi_agent", "shell_tool", "unified_exec",
  "shell_snapshot", "browser_use", "browser_use_external", "browser_use_full_cdp_access",
  "computer_use", "image_generation", "view_image", "skill_search", "workspace_dependencies",
  "code_mode_host", "memories", "sleep_tool", "in_app_browser", "skip_host_skill_discovery", "respect_system_proxy"];
const profile = { executable:process.execPath, cwd:resolve("empty"), schemaPath:resolve("estimate.schema.json"),
  instructionsPath:resolve("instructions.md"), version:"0.153.3", features };
const metrics = {activeSeconds:120,progress:0.5,toolCount:8,validationFailures:0};

it('external account sessions keep isolated tools and proxy without file credential storage',()=>{
 const env={CODEX_HOME:resolve('main-home'),OPENAI_API_KEY:'must-not-inherit',HTTPS_PROXY:'http://proxy.invalid'};
 const invocation=buildObserverExternalInvocation(profile,env,resolve('observer-home'));
 expect(invocation.args.slice(0,3)).toEqual(['app-server','--stdio','--strict-config']);
 expect(invocation.args).toContain('cli_auth_credentials_store="ephemeral"');
 expect(invocation.args).not.toContain('cli_auth_credentials_store="file"');
 expect(invocation.args.flatMap((v,i)=>v==='--disable'?[invocation.args[i+1]]:[])).toEqual(features.slice(0,-2));
 expect(invocation.env).toEqual({CODEX_HOME:resolve('observer-home'),HTTPS_PROXY:'http://proxy.invalid'});
 expect(invocation.input).toBe('');
 expect(()=>buildObserverExternalInvocation(profile,env,env.CODEX_HOME)).toThrow('OBSERVER_AUTH_HOME_REQUIRED');
});

it.each(['login', 'status', 'metadata'] as const)('isolates %s setup from main authentication', action => {
  const env = {CODEX_HOME:resolve('main-home'), codex_home:resolve('other-main'), HTTPS_PROXY:'http://proxy.invalid', OPENAI_API_KEY:'private'};
  const invocation = buildObserverSetupInvocation(profile, action, env, resolve('observer-home'));
  const prefix = action === 'login' ? ['login'] : action === 'status' ? ['login', 'status'] : ['app-server', '--stdio', '--strict-config'];
  expect(invocation.args.slice(0, prefix.length)).toEqual(prefix);
  expect(invocation.env).toEqual({CODEX_HOME:resolve('observer-home'), HTTPS_PROXY:'http://proxy.invalid'});
  expect(invocation.input).toBe('');
  for (const config of ['cli_auth_credentials_store="file"', 'forced_login_method="chatgpt"', 'model_provider="openai"', 'features.respect_system_proxy=true']) expect(invocation.args).toContain(config);
  for (const flag of ['--with-api-key', '--with-access-token', '--ignore-user-config']) expect(invocation.args).not.toContain(flag);
  expect(() => buildObserverSetupInvocation(profile, action, env, env.CODEX_HOME)).toThrow('OBSERVER_AUTH_HOME_REQUIRED');
  expect(() => buildObserverSetupInvocation(profile, action, env)).toThrow('OBSERVER_AUTH_HOME_REQUIRED');
});

it('builds guarded official logout and device-auth actions in the independent home', () => {
  const env = {CODEX_HOME:resolve('main-home'), HTTPS_PROXY:'http://proxy.invalid', OPENAI_API_KEY:'private'};
  expect(buildObserverSetupInvocation(profile, 'logout', env, resolve('observer-home')).args.slice(0, 1)).toEqual(['logout']);
  expect(buildObserverSetupInvocation(profile, 'device-auth', env, resolve('observer-home')).args.slice(0, 2)).toEqual(['login', '--device-auth']);
  expect(buildObserverSetupInvocation(profile, 'logout', env, resolve('observer-home')).env)
    .toEqual({CODEX_HOME:resolve('observer-home'), HTTPS_PROXY:'http://proxy.invalid'});
});

it('rejects arbitrary setup commands', () => {
  expect(() => buildObserverSetupInvocation(profile, 'exec' as 'login', {}, resolve('observer-home'))).toThrow('INVALID_OBSERVER_SETUP_ACTION');
});

it('accepts the verified 0.153.4 profile without changing isolation or subscription route', () => {
  expect(buildCodexInvocation({...profile, version: '0.153.4'}, metrics, {}).args)
    .toEqual(buildCodexInvocation(profile, metrics, {}).args);
});

it('uses the same isolated subscription profile for bounded rich stdin, never CLI arguments', () => {
  const observer = {goalSummary: null, activeSeconds: 120, runtime: 'running',
    messages: [{kind: 'user', text: 'PRIVATE task content', truncated: false}], truncated: false};
  const invocation = buildObserverCodexInvocation(profile, observer, {HTTPS_PROXY: 'http://proxy.invalid', OPENAI_API_KEY: 'secret'}, resolve('observer-home'));
  expect(invocation.args).toContain('cli_auth_credentials_store="file"');
  expect(invocation.args.join(' ')).not.toContain('PRIVATE');
  expect(JSON.parse(invocation.input)).toEqual(observer);
  expect(invocation.env).toEqual({HTTPS_PROXY: 'http://proxy.invalid', CODEX_HOME: resolve('observer-home')});
  expect(() => buildObserverCodexInvocation(profile, {...observer, sessionKey: 'PRIVATE'}, {})).toThrow('INVALID_OBSERVER_INPUT');
});

it('builds compression with separately pinned summary assets and trusted stdin', () => {
  const request = {text: 'older context', firstOrdinal: 4, lastOrdinal: 8};
  const compressionProfile = {...profile,
    compressionSchemaPath: resolve('context-summary.schema.json'),
    compressionInstructionsPath: resolve('context-summary-instructions.md')};
  const invocation = buildObserverCompressionInvocation(compressionProfile, JSON.stringify(request),
    {HTTPS_PROXY: 'http://proxy.invalid', OPENAI_API_KEY: 'secret'}, resolve('observer-home'));
  expect(invocation.args).toContain(compressionProfile.compressionSchemaPath);
  expect(invocation.args).toContain(`model_instructions_file=${JSON.stringify(compressionProfile.compressionInstructionsPath)}`);
  expect(invocation.args.join(' ')).not.toContain(request.text);
  expect(invocation.input).toBe(JSON.stringify(request));
  expect(invocation.env).toEqual({HTTPS_PROXY: 'http://proxy.invalid', CODEX_HOME: resolve('observer-home')});
});

it('refuses observer dispatch without an explicit separate home', () => {
  const input = {goalSummary:null, activeSeconds:0, runtime:'running', messages:[{kind:'user', text:'task', truncated:false}], truncated:false};
  const env = {CODEX_HOME:resolve('main-home'), USERPROFILE:resolve('main-user')};
  for (const home of [undefined, '', 'relative', resolve('/'), env.CODEX_HOME,
    resolve('main-home/child'), resolve('main-user/.codex'), resolve('main-user/.codex/child')]) {
    expect(() => buildObserverCodexInvocation(profile, input, env, home)).toThrow('OBSERVER_AUTH_HOME_REQUIRED');
  }
});

it('replaces every ambient home spelling without altering the main environment or proxy', () => {
  const input = {goalSummary:null, activeSeconds:0, runtime:'running', messages:[{kind:'user', text:'task', truncated:false}], truncated:false};
  const env = {CODEX_HOME:resolve('main-home'), codex_home:resolve('other-main'), HTTPS_PROXY:'http://proxy.invalid', OPENAI_API_KEY:'private'};
  const before = {...env};
  const invocation = buildObserverCodexInvocation(profile, input, env, resolve('observer-home'));
  expect(invocation.env).toEqual({CODEX_HOME:resolve('observer-home'), HTTPS_PROXY:'http://proxy.invalid'});
  expect(env).toEqual(before);
  expect(invocation.args.slice(-3)).toEqual(['-c', 'cli_auth_credentials_store="file"', '-']);
  expect(() => buildObserverCodexInvocation(profile, input, env, env.codex_home)).toThrow('OBSERVER_AUTH_HOME_REQUIRED');
});

it("emits isolated subscription-only arguments with numeric-only stdin", () => {
  const invocation=buildCodexInvocation(profile,metrics,{});
  const args=invocation.args;
  expect(args.slice(0,14)).toEqual(["exec","--ignore-user-config","--strict-config","--ephemeral",
    "--skip-git-repo-check","--sandbox","read-only","--model","gpt-5.6-luna","--color","never","--json","--output-schema",profile.schemaPath]);
  expect(args.slice(-1)).toEqual(["-"]);
  const config=args.flatMap((arg,i)=>arg==="-c"?[args[i+1]]:[]);
  expect(config).toEqual(expect.arrayContaining(['forced_login_method="chatgpt"','model_provider="openai"',
    'model_reasoning_effort="medium"','features.respect_system_proxy=true','approval_policy="never"',
    'web_search="disabled"','project_doc_max_bytes=0','history.persistence="none"','features.skip_host_skill_discovery=true',
    `model_instructions_file=${JSON.stringify(profile.instructionsPath)}`]));
  expect(args.flatMap((arg,i)=>arg==="--disable"?[args[i+1]]:[])).toEqual(features.slice(0,-2));
  expect(JSON.parse(invocation.input)).toEqual(metrics);
});
it("preserves proxy and login location while stripping case-insensitive API overrides without mutation", () => {
  const env={HTTPS_PROXY:"http://proxy.invalid",no_proxy:"localhost",CODEX_HOME:resolve("login"),
    OPENAI_API_KEY:"secret",OpenAI_Base_Url:"https://override.invalid",codex_api_key:"secret2",openai_api_base:"override"};
  expect(buildCodexInvocation(profile,metrics,env).env).toEqual({HTTPS_PROXY:env.HTTPS_PROXY,no_proxy:"localhost",CODEX_HOME:env.CODEX_HOME});
  expect(env.OPENAI_API_KEY).toBe("secret");
});
it.each(["0.153.2","0.154.0",""])("rejects an unverified version %s", version => {
  expect(()=>buildCodexInvocation({...profile,version},metrics,{})).toThrow("UNSUPPORTED_CODEX_PROFILE");
});
it.each(["respect_system_proxy","hooks","shell_tool","skip_host_skill_discovery"])("requires capability %s", missing => {
  expect(()=>buildCodexInvocation({...profile,features:features.filter(f=>f!==missing)},metrics,{})).toThrow("UNSUPPORTED_CODEX_PROFILE");
});
it.each(["executable","cwd","schemaPath","instructionsPath"])("rejects relative or control-character %s", field => {
  for (const value of ["relative",resolve("bad")+"\n"]) {
    expect(()=>buildCodexInvocation({...profile,[field]:value},metrics,{})).toThrow("UNSUPPORTED_CODEX_PROFILE");
  }
});
it("rejects extra task text and nonfinite metrics without echoing payloads", () => {
  for (const value of [{...metrics,prompt:"private"},{...metrics,activeSeconds:Infinity}]) {
    expect(()=>buildCodexInvocation(profile,value,{})).toThrow("INVALID_ESTIMATION_METRICS");
  }
});
it("excludes unrelated secrets and execution overrides while retaining platform essentials", () => {
  const env={SystemRoot:"C:\\Windows",TEMP:"C:\\Temp",USERPROFILE:"C:\\Users\\test",PATH:"C:\\Windows\\System32",
    SSL_CERT_FILE:"C:\\trust.pem",HTTPS_PROXY:"http://proxy.invalid",GITHUB_TOKEN:"private",
    NODE_OPTIONS:"--require malicious",LD_PRELOAD:"malicious",RUST_LOG:"trace",CODEX_EXEC_WRAPPER:"malicious"};
  expect(buildCodexInvocation(profile,metrics,env).env).toEqual({SystemRoot:env.SystemRoot,TEMP:env.TEMP,
    USERPROFILE:env.USERPROFILE,PATH:env.PATH,SSL_CERT_FILE:env.SSL_CERT_FILE,HTTPS_PROXY:env.HTTPS_PROXY});
});
