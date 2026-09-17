// Synthetic-only compression-boundary localization. Never pass a history path.
import {constants} from 'node:fs';
import {copyFile, mkdir, lstat, readFile, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readObserverPilotConfig, observerPilotEnvironment} from '../../dist/desktop/observer-pilot-config.js';
import {createObserverIdentityRuntime} from '../../dist/estimation/observer-identity-runtime.js';
import {createObserverConsentGate} from '../../dist/estimation/observer-consent.js';
import {createNativeObserverTrial} from '../../dist/desktop/native-observer-trial.js';
import {createObserverSessionProcess} from '../../dist/estimation/observer-session-process.js';
import {createPersistentObserverSession} from '../../dist/estimation/observer-persistent-session.js';
import {createPersistentReceiptJournal} from '../../dist/estimation/observer-persistent-receipt.js';
import {createNativeSourceSnapshot} from '../../dist/observer/native-source-snapshot.js';
import {readOwnedNativeCheckpoint} from '../../dist/evaluation/native-owned-checkpoint.js';
import {loadObserverApiAssets} from '../../dist/estimation/observer-api-assets.js';
import {openReleaseAccounting} from '../../dist/estimation/release-accounting.js';
import {openApprovedNativeLocalizationSeries} from '../../dist/evaluation/native-trial-authority.js';
import {runSyntheticSeedOperation} from '../../dist/evaluation/native-seed-operation.js';
import {classifyNativeTrialEvent, describeNativeTrialOutput} from '../../dist/evaluation/native-trial-events.js';
import {createNativeComparisonFixtures, NATIVE_COMPARISON_FIXTURE_VERSION} from '../../dist/evaluation/native-comparison-fixture.js';
import {observerResponseSchema} from '../../dist/estimation/observer-contract.js';
import {nativePreservationInstructions} from '../../dist/estimation/native-preservation.js';
import {createNativeStorage} from '../../dist/estimation/native-storage.js';

export function createLocalizationAccountingView({view, budget, branch}) {
  return {
    ...view,
    async reserve(kind, purpose) {
      const trialId = await budget.reserve(purpose === 'context_compression' ? 'compaction' : 'eta');
      try {
        const id = await view.reserve(kind, purpose);
        if (!id) throw Error('TRIAL_LEDGER_ADMISSION_DENIED');
        branch.slot = {id, trialId, purpose, settled: false};
        branch.purpose = purpose;
        return id;
      } catch (error) {
        await budget.settle(trialId, 'failed');
        throw error;
      }
    },
    async settle(id, usage, classification) {
      await view.settle(id, usage, classification);
      if (!branch.slot || branch.slot.id !== id || branch.slot.settled) throw Error('TRIAL_UNKNOWN_RESERVATION');
      branch.slot.settled = true;
      await budget.settle(branch.slot.trialId,
        classification === 'confirmed_compression_unknown' || classification === 'known_success' ? 'completed' : 'failed');
      branch.purpose = undefined;
    },
    async cancelBeforeDispatch(id) {
      await view.cancelBeforeDispatch(id);
      if (branch.slot?.id === id && !branch.slot.settled) {
        branch.slot.settled = true;
        await budget.settle(branch.slot.trialId, 'failed');
      }
      branch.purpose = undefined;
    },
  };
}

export async function captureLocalizationAccounting(ledger) {
  try{return ledger.snapshot();}finally{await ledger.close();}
}
export async function openLocalizationSnapshot({branchPath,readerRoot,sourceThreadId,label,revision,rollout,signal,destination}) {
  return createNativeSourceSnapshot({sourcePath:branchPath,sourceRoot:readerRoot,sourceThreadId,sourceEpoch:1,
    revision,byteWatermark:Buffer.byteLength(rollout),signal,...destination});
}

export function createLocalizationBranchRegistry() {
  const branches = new Set();
  return {
    track(branch) { branches.add(branch); return branch; },
    untrack(branch) { branches.delete(branch); },
    size() { return branches.size; },
    list() { return [...branches]; },
    async closeAll(close) {
      const errors = [];
      for (const branch of [...branches]) {
        try { await close(branch); branches.delete(branch); }
        catch (error) { errors.push(error); }
      }
      return errors;
    },
  };
}

export async function closeLocalizationBranch(branch) {
  if (branch.cleanupStarted) throw Error('NATIVE_BRANCH_CLEANUP_ALREADY_ATTEMPTED');
  branch.cleanupStarted = true;
  let ownerConfirmed = !branch.owner;
  if (branch.owner) {
    try { await branch.owner.close(); }
    catch (error) { branch.cleanupError = error; throw error; }
    ownerConfirmed = branch.owner.status().closed === true;
    if (!ownerConfirmed) {
      const error = Error('TRIAL_OWNER_EXIT_UNCONFIRMED');
      branch.cleanupError = error;
      throw error;
    }
  }
  if (branch.claim && !ownerConfirmed) throw Error('NATIVE_OWNER_EXIT_UNCONFIRMED');
  // An exit receipt is evidence, not cleanup bookkeeping. Never write it
  // until the process is confirmed closed; never delete custody after a
  // failed receipt write.
  if (branch.owner && branch.ownerStarted === true && branch.journal && branch.ownerUuid) {
    await branch.journal.processExit({ownerUuid: branch.ownerUuid, sourceKey: `native-localization-${branch.label}`, sourceEpoch: `localization-${branch.label}`, processExitState: 'closed', at: Date.now()});
  }
  if (branch.claim) await branch.claim.afterProcessClosed();
  if (branch.snapshot) await branch.snapshot.close();
  if (branch.resources) await branch.resources.release();
  if (branch.view) await branch.view.close();
  // The append-only journal owns no persistent handle. Each receipt write,
  // including processExit above, is awaited; its interface has no close().
}

export async function admitLocalizationOperation({branch, purpose, now = Date.now}) {
  let id;
  try {
    id = await branch.view.reserve('ordinary', purpose);
    await branch.view.bindInvocation(id, {admissionId: id, conversationKey: `native-localization-${branch.label}`, turnGeneration: 0, ownerUuid: branch.ownerUuid, providerKind: 'subscription', phase: 'bound', deadline: now() + 120000, cleanupOutcome: 'pending', purpose, pid: branch.pid, creationIdentity: branch.creationIdentity});
    branch.operationId = randomUUID();
    await branch.journal.operationStarted({operationId: branch.operationId, admissionId: id, ownerUuid: branch.ownerUuid, sourceKey: `native-localization-${branch.label}`, sourceEpoch: `localization-${branch.label}`, generation: 0, operationKind: purpose});
    branch.operationStarted = true;
    return id;
  } catch (error) {
    if (id !== undefined && branch.slot?.settled !== true) await branch.view.cancelBeforeDispatch(id).catch(() => undefined);
    throw error;
  }
}

export async function settleLocalizationProbe({branch, id, result, recordTerminal}) {
  await recordTerminal(result);
  await branch.view.updateInvocation(id, {phase: 'settling', cleanupOutcome: 'pending'});
  const usage = result.usage ? {inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cachedInputTokens: result.usage.cachedInputTokens} : null;
  const classification = usage === null ? (result.terminalConfirmed && !result.cancelled ? 'safe_unknown' : 'unsafe_unknown') :
    result.interpretation === null ? 'known_non_success' : 'known_success';
  branch.settlementAttempted = true;
  await branch.view.settle(id, usage, classification);
  if (branch.slot) branch.slot.settled = true;
}

export function assertKnownLocalizationEta(result) {
  if (!result?.terminalConfirmed || result.cancelled || result.usage === null || result.usage === undefined) {
    throw Error('LOCALIZATION_ETA_USAGE_UNVERIFIED');
  }
}

export function verifyLocalizationContext(summary, expectedMarkers, diagnostics, branch) {
  const markerFound = expectedMarkers.map(marker => summary.includes(marker));
  const imageColorFound = /\bred\b/iu.test(summary);
  const verified = markerFound.every(Boolean) && imageColorFound;
  // Preserve per-fact outcomes before failure; never put response text or
  // expected answers in the report, imported checkpoint or next probe.
  diagnostics.push({branch, markerFound, imageColorFound, verified});
  if (!verified) throw Error('LOCALIZATION_CONTEXT_UNVERIFIED');
}

export function localizationForkParameters(params, guidance, placement, baseGuidance = guidance) {
  if (!params || typeof params.developerInstructions !== 'string' ||
    (placement === 'base-and-developer' && typeof params.baseInstructions !== 'string')) throw Error('TRIAL_TRUSTED_INSTRUCTIONS_MISSING');
  if (!['developer','base-and-developer'].includes(placement)) throw Error('TRIAL_GUIDANCE_PLACEMENT_INVALID');
  return {...params,developerInstructions:`${params.developerInstructions}\n${guidance}`,
    ...(placement === 'base-and-developer' ? {baseInstructions:`${params.baseInstructions}\n${baseGuidance}`} : {})};
}

export async function injectLocalizationPreservation({rpc,forkId,sourceThreadId,purpose,guidance,signal}) {
  signal.throwIfAborted();
  if (typeof forkId !== 'string' || !forkId || forkId === sourceThreadId || purpose !== 'context_compression' ||
    typeof guidance !== 'string' || !guidance || Buffer.byteLength(guidance) > 8192) throw Error('TRIAL_INJECTION_UNADMITTED');
  const ack = await rpc.call('thread/inject_items',{threadId:forkId,items:[
    {type:'message',role:'developer',content:[{type:'input_text',text:guidance}]}
  ]});
  signal.throwIfAborted();
  if (!ack || typeof ack !== 'object' || Array.isArray(ack) || Object.keys(ack).length !== 0) throw Error('TRIAL_INJECTION_ACK_INVALID');
}

export function buildPinnedLocalizationSource({metadata, pin, framingTail}) {
  if (typeof metadata !== 'string' || !metadata.endsWith('\n')) throw Error('LOCALIZATION_SOURCE_METADATA_INVALID');
  if (typeof pin?.serializedEnvelope !== 'string' || pin.serializedEnvelope.length === 0) throw Error('LOCALIZATION_CHECKPOINT_PIN_INVALID');
  const tailLines = framingTail.trimEnd() === '' ? [] : framingTail.trimEnd().split('\n');
  for (const line of tailLines) {
    let entry;
    try { entry = JSON.parse(line); } catch { throw Error('LOCALIZATION_SOURCE_TAIL_INVALID'); }
    if (!entry || entry.type !== 'event_msg') throw Error('LOCALIZATION_SOURCE_TAIL_INVALID');
  }
  return `${metadata}${pin.serializedEnvelope}\n${framingTail}`;
}

let localizationApiPromise;
async function localizationApi() {
  localizationApiPromise ??= import('../../dist/evaluation/native-compression-localization.js');
  return localizationApiPromise;
}

async function main() {
const [configPath, outputDirectory, mode] = process.argv.slice(2);
if (process.argv.length !== 5 || !isAbsolute(configPath ?? '') || !isAbsolute(outputDirectory ?? '') ||
  !['--preflight', '--run-approved-3x1', '--run-approved-3x1-base-guidance', '--run-approved-3x1-generic-guidance', '--run-approved-3x1-history-guidance'].includes(mode)) {
  throw Error('EXPLICIT_SYNTHETIC_LOCALIZATION_ARGUMENTS_REQUIRED');
}
const canonical = path => resolve(path).toLowerCase();
if (!process.env.APPDATA || canonical(configPath) !== canonical(join(process.env.APPDATA, 'codex-progress-hud', 'observer-pilot.json'))) {
  throw Error('TRIAL_CONFIG_AUTHORITY_INVALID');
}

const root = resolve(outputDirectory);
await mkdir(root, {recursive: true});
if ((await lstat(root)).isSymbolicLink()) throw Error('TRIAL_OUTPUT_REPARSE');
const hash = value => createHash('sha256').update(value).digest('hex');
const stage = async (source, target) => {
  try { await copyFile(source, target, constants.COPYFILE_EXCL); }
  catch (error) {
    if (error.code !== 'EEXIST' || hash(await readFile(source)) !== hash(await readFile(target))) throw Error('TRIAL_ASSET_MISMATCH');
  }
};
const resourcesDirectory = join(root, 'resources');
await mkdir(join(resourcesDirectory, 'observer-assets'), {recursive: true});
for (const name of ['observer.schema.json', 'observer-instructions.md', 'context-summary.schema.json', 'context-summary-instructions.md']) {
  await stage(resolve('src/estimation/assets', name), join(resourcesDirectory, 'observer-assets', name));
}
await stage(resolve('scripts/windows/observer-home.ps1'), join(resourcesDirectory, 'observer-home.ps1'));

const config = await readObserverPilotConfig(configPath);
const PINNED_HASH = 'ccdc9eb9dd71fbcfb03ad42c4eca2b0d6ff6fbd32ebe9416550e6244561e559b';
if (!config || config.version !== '0.153.4' || config.executableSha256 !== PINNED_HASH) throw Error('TRIAL_PIN_UNVERIFIED');
const identityOptions = {
  ...config,
  resourcesDirectory,
  powershell: join(process.env.SystemRoot ?? process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
  environment: observerPilotEnvironment(config, process.env),
};

const run = mode !== '--preflight';
const genericGuidance = mode === '--run-approved-3x1-generic-guidance';
const historyGuidance = mode === '--run-approved-3x1-history-guidance';
const guidancePlacement = genericGuidance || mode === '--run-approved-3x1-base-guidance' ? 'base-and-developer' : 'developer';
const controller = new AbortController();
const identity = createObserverIdentityRuntime(identityOptions);
const gate = createObserverConsentGate({now: Date.now, onInvalidate: () => controller.abort()});
const sourceThreadId = '88888888-8888-4888-8888-888888888888';
const readerRoot = join(root, 'synthetic-source');
const sourceDay = join(readerRoot, '2026', '09', '14');
const sourcePath = join(sourceDay, `rollout-2026-09-14T12-00-00-${sourceThreadId}.jsonl`);
const fixtures = createNativeComparisonFixtures({sourceThreadId, cwd: config.cwd});
const raw = fixtures[1];
const rawLines = raw.rollout.trimEnd().split('\n');
const sourceMetadata = `${rawLines[0]}\n`;
const sourceFramingTail = fixtures[2].rollout.trimEnd().split('\n')
  .map(line => JSON.parse(line))
  .filter(entry => entry.type === 'event_msg')
  .map(entry => JSON.stringify(entry) + '\n')
  .join('');
const frozenSource = Object.freeze({
  rollout: raw.rollout,
  sourceHash: hash(raw.rollout),
  metadata: sourceMetadata,
  framingTail: sourceFramingTail,
  currentTurnId: raw.currentTurnId,
  expectedMarkers: Object.freeze([...raw.expectedMarkers]),
  expectedImageColor: raw.expectedImageColor,
});
const evidenceInstruction = 'This is an authorized synthetic context-access check. Still estimate only; do not execute source work or tools. In the schema summary, report the identifier in the first user message of the source conversation (not an assistant checkpoint), the identifier in the paired tool output, the identifier in the latest assistant progress checkpoint, and the dominant color actually observed in the reference image. Retrieve these facts from inherited/imported source context; do not invent missing facts. Preserve these acceptance facts when compacting synthetic history.';
const report = {
  synthetic: true,
  diagnosticOnly: true,
  mode,
  guidancePlacement,
  historyGuidance,
  baseGuidanceKind: genericGuidance ? 'generic-task-facts' : guidancePlacement === 'base-and-developer' ? 'diagnostic-fact-request' : 'unchanged',
  approvedTrialId: null,
  budgetPolicy: {eta: 3, explicitCompaction: 1},
  model: 'gpt-5.6-luna',
  effort: 'medium',
  serviceTier: 'default',
  fixtureVersion: NATIVE_COMPARISON_FIXTURE_VERSION,
  evidenceScope: 'compression-boundary localization; not ETA accuracy or a performance gate',
  source: {hash: frozenSource.sourceHash, bytes: Buffer.byteLength(frozenSource.rollout), metadataHash: hash(sourceMetadata), framingTailHash: hash(sourceFramingTail)},
  phases: [], checks: [], branches: [], events: [], outputDiagnostics: [], terminalDiagnostics: [],
  errors: [], knownTokens: 0, unknownUsage: 0, automaticCompactions: 0, cleanupConfirmed: false, failureBoundary: null,
};
const owners = new Set();
const branchRegistry = createLocalizationBranchRegistry();
const automaticWrites = [];
let budget;
let ledger;
let expectedBinding;
let stopped = false;
let activePhase = 'setup';
const phase = async (name, work) => {
  const started = performance.now();
  const previous = activePhase;
  activePhase = name;
  try { return await work(); }
  catch (error) { if (error && typeof error === 'object') error.localizationPhase ??= name; throw error; }
  finally { report.phases.push({name, elapsedMs: performance.now() - started}); activePhase = previous; }
};
const bindingOf = prepared => ({accountFingerprint: prepared.evidence.accountFingerprint, routeFingerprint: prepared.evidence.routeFingerprint, assetsFingerprint: prepared.evidence.assetsFingerprint});
async function prepareSession(signal) {
  const prepared = await identity.prepareSession(signal, {accountCache: 'bypass'});
  gate.update(prepared.evidence);
  if (!gate.authorized() || JSON.stringify(bindingOf(prepared)) !== expectedBinding) throw Error('TRIAL_ACCOUNT_BINDING_CHANGED');
  return {invocation: prepared.invocation, binding: bindingOf(prepared)};
}
function failStop(code, phaseName = activePhase) {
  if (!stopped) {
    stopped = true;
    report.failureBoundary = {phase: phaseName, code};
    report.errors.push(code);
    controller.abort();
    for (const owner of owners) owner.disable();
  }
}
function recordNotification(branch, notification) {
  const type = notification.params.item?.type;
  const action = classifyNativeTrialEvent(notification.method, type, branch.purpose);
  if (notification.method === 'turn/started' || notification.method === 'item/started') {
    if (report.events.length >= 256) { failStop('TRIAL_EVENT_LIMIT'); return; }
    const known = ['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction'];
    report.events.push({branch: branch.label, method: notification.method, itemType: known.includes(type) ? type : 'unrecognized', action});
  }
  if (type === 'contextCompaction') {
    const itemId = typeof notification.params.item?.id === 'string' ? notification.params.item.id : undefined;
    const turn = notification.params.turnId ?? notification.params.turn?.id;
    const turnId = typeof turn === 'string' ? turn : undefined;
    if (notification.method === 'item/completed' && itemId && turnId) branch.compactionEvidence = {itemId, turnId, completedAt: Date.now()};
  }
  if (action === 'unexpected_turn') failStop('UNADMITTED_TURN');
  if (action === 'unexpected_item') failStop('UNEXPECTED_EXECUTABLE_ITEM');
  if (action === 'unexpected_compaction') {
    report.automaticCompactions += 1;
    if (budget) automaticWrites.push(budget.observeAutomaticCompaction().catch(() => report.errors.push('AUTOMATIC_COMPACTION_AUDIT_FAILED')));
    failStop('UNEXPECTED_AUTOMATIC_COMPACTION');
  }
}
function processFactory(branch) {
  const owner = createObserverSessionProcess();
  owners.add(owner);
  branch.owner = owner;
  return {
    ...owner,
    start: async invocation => {
      const opened = await owner.start(invocation);
      branch.pid = opened.pid;
      branch.creationIdentity = opened.creationIdentity;
      const rpc = opened.rpc;
      branch.rpc = rpc;
      rpc.subscribe(notification => recordNotification(branch, notification));
      const call = rpc.call;
      rpc.call = async (method, params) => {
        const allowed = ['initialize', 'thread/fork', 'thread/read', 'thread/goal/clear', 'thread/goal/get', 'turn/start', 'turn/interrupt', 'thread/compact/start', 'thread/inject_items'];
        if (!allowed.includes(method)) throw Error('TRIAL_RPC_FORBIDDEN');
        if (method === 'turn/start' && branch.purpose !== 'eta') throw Error('TRIAL_RPC_UNADMITTED');
        if (method === 'thread/compact/start' && branch.purpose !== 'context_compression') throw Error('TRIAL_RPC_UNADMITTED');
        if (method === 'thread/inject_items' && (branch.label !== 'B' || branch.purpose !== 'context_compression' ||
          !branch.forkId || params?.threadId !== branch.forkId || branch.forkId === sourceThreadId ||
          JSON.stringify(params.items)!==JSON.stringify([{type:'message',role:'developer',content:[{type:'input_text',text:nativePreservationInstructions}]}])))
          throw Error('TRIAL_INJECTION_UNADMITTED');
        if (method === 'turn/start' && (!params || params.model !== 'gpt-5.6-luna' || params.effort !== 'medium' || params.serviceTierForTurn !== 'default')) throw Error('TRIAL_MODEL_PROFILE_INVALID');
        if (method === 'thread/fork') {
          params = localizationForkParameters(params, evidenceInstruction, guidancePlacement, genericGuidance ? nativePreservationInstructions : evidenceInstruction);
          branch.reportEntry.instructions = {baseHash:hash(params.baseInstructions),developerHash:hash(params.developerInstructions)};
        }
        const result = await call(method, params);
        if (method === 'thread/fork') {
          branch.forkId = result?.thread?.id;
          branch.forkPath = result?.thread?.path;
        }
        return result;
      };
      return opened;
    },
  };
}
function boundedView(label, branch) {
  const view = ledger.forConversation(`native-localization-${label}`);
  return createLocalizationAccountingView({view, budget, branch});
}
async function openBranch(label, rollout, turnId, revision, assets, registry) {
  const branch = registry.track({label, purpose: undefined, compactionEvidence: undefined, forkId: undefined, forkPath: undefined, owner: undefined, ownerStarted: false, slot: undefined, pid: undefined, creationIdentity: undefined});
  branch.reportEntry = {label, sourceHash: hash(rollout), sourceBytes: Buffer.byteLength(rollout), forkId: null, knownTokens: 0, unknownUsage: false};
  const branchPath = join(sourceDay, `rollout-${label}-${sourceThreadId}.jsonl`);
  await writeFile(branchPath, rollout, {flag: 'wx', mode: 0o600});
  const resources = createNativeObserverTrial(identityOptions, {maxSourceBytes: 1024 * 1024});
  branch.resources = resources;
  const destination = await resources.destination(controller.signal);
  const snapshot = await openLocalizationSnapshot({branchPath,readerRoot,sourceThreadId,label,revision,rollout,signal:controller.signal,destination});
  branch.snapshot = snapshot;
  const prepared = await prepareSession(controller.signal);
  const owner = processFactory(branch);
  const opened = await owner.start(prepared.invocation);
  const ownerUuid = randomUUID();
  const journal = createPersistentReceiptJournal(join(root, `${label}-receipts`));
  branch.ownerUuid = ownerUuid;
  branch.journal = journal;
  await journal.ownerStarted({ownerUuid, sourceKey: `native-localization-${label}`, sourceEpoch: `localization-${label}`, pid: opened.pid, creationIdentity: opened.creationIdentity, binding: prepared.binding});
  branch.ownerStarted = true;
  await opened.rpc.call('initialize', {clientInfo: {name: 'hud_native_compression_localization', version: '1.0.0'}, capabilities: {experimentalApi: true}});
  opened.rpc.notify('initialized', {});
  const claim = await resources.claim({snapshot: {...snapshot, sourceTurnId: turnId}, currentTurnId: turnId}, prepared.invocation, {pid: opened.pid, creationIdentity: opened.creationIdentity}, controller.signal);
  branch.claim = claim;
  const session = createPersistentObserverSession(opened.rpc, {cwd: config.cwd, outputSchema: assets.schema, now: Date.now, nativeInstructions: assets.instructions});
  branch.session = session;
  await session.startNative({sourceThreadId, path: snapshot.path, custodyTag: claim.tag}, controller.signal, claim.recordFork);
  if (!branch.forkPath) {
    const view = await opened.rpc.call('thread/read', {threadId: branch.forkId, includeTurns: false});
    branch.forkPath = view?.thread?.path;
  }
  if (!isAbsolute(branch.forkPath ?? '')) throw Error('TRIAL_FORK_PATH_UNVERIFIED');
  branch.view = boundedView(label, branch);
  branch.reportEntry.forkId = branch.forkId ?? null;
  report.branches.push(branch.reportEntry);
  return branch;
}
async function closeBranch(branch) {
  try { await closeLocalizationBranch(branch); }
  finally { if (branch.owner?.status().closed === true) owners.delete(branch.owner); }
}
async function admit(branch, purpose) {
  return admitLocalizationOperation({branch, purpose, now: Date.now});
}
async function probe(branch, input) {
  let id;
  let dispatched = false;
  let terminalAttempted = false;
  try {
    id = await admit(branch, 'eta');
    await branch.view.updateInvocation(id, {phase: 'dispatching'});
    dispatched = true;
    const result = await branch.session.estimate(input, controller.signal, async evidence => {
      if (evidence.kind === 'snapshot') { branch.knownUsage = evidence.last.inputTokens + evidence.last.outputTokens; await branch.journal.usageSnapshot({operationId: branch.operationId, sourceKey: `native-localization-${branch.label}`, sourceEpoch: `localization-${branch.label}`, generation: 0, ...evidence, completenessReason: 'observed'}); }
      else { branch.unknownUsage = true; await branch.journal.usageGap({operationId: branch.operationId, sourceKey: `native-localization-${branch.label}`, sourceEpoch: `localization-${branch.label}`, generation: 0, ...evidence}); }
    });
    await settleLocalizationProbe({
      branch,
      id,
      result,
      recordTerminal: async terminalResult => {
        terminalAttempted = true;
        await branch.journal.operationTerminal({operationId: branch.operationId, admissionId: id, ownerUuid: branch.ownerUuid, sourceKey: `native-localization-${branch.label}`, sourceEpoch: `localization-${branch.label}`, generation: 0, ...(terminalResult.turnId ? {turnId: terminalResult.turnId} : {}), terminalState: terminalResult.cancelled ? 'cancelled' : terminalResult.terminalConfirmed ? 'completed' : 'unconfirmed', usageCompleteness: terminalResult.usageCompleteness, operationKind: 'eta'});
      },
    });
    branch.reportEntry.knownTokens = branch.knownUsage ?? 0;
    branch.reportEntry.unknownUsage = branch.unknownUsage === true || result.usage === null;
    assertKnownLocalizationEta(result);
    const checked = observerResponseSchema.safeParse(result.interpretation);
    if (!checked.success || !result.terminalConfirmed || result.cancelled || checked.data.status !== 'running' || checked.data.estimate === null || !Number.isFinite(checked.data.estimate.remainingSeconds)) throw Error('LOCALIZATION_ETA_INVALID');
    const summary = checked.data.summary ?? '';
    verifyLocalizationContext(summary, frozenSource.expectedMarkers, report.outputDiagnostics, branch.label);
    branch.probe = {terminal: 'completed', usage: result.usage ? 'known' : 'unknown', summaryShape: describeNativeTrialOutput(JSON.stringify(result.interpretation))};
    return result;
  } catch (error) {
    if (id !== undefined && !terminalAttempted) {
      terminalAttempted = true;
      await branch.journal.operationTerminal({operationId: branch.operationId, admissionId: id, ownerUuid: branch.ownerUuid, sourceKey: `native-localization-${branch.label}`, sourceEpoch: `localization-${branch.label}`, generation: 0, terminalState: dispatched ? 'unconfirmed' : 'cancelled', usageCompleteness: dispatched ? 'protocol_failed' : 'cancelled_before_dispatch', operationKind: 'eta'}).catch(() => undefined);
    }
    if (id !== undefined && branch.slot && !branch.slot.settled && !branch.settlementAttempted) {
      if (dispatched) await branch.view.settle(id, null, 'unsafe_unknown').catch(() => undefined);
      else await branch.view.cancelBeforeDispatch(id).catch(() => undefined);
    }
    branch.purpose = undefined; throw error;
  }
}
async function explicitCompression(branch) {
  const id = await admit(branch, 'context_compression');
  const {runNativeLocalizationOperation} = await localizationApi();
  await runNativeLocalizationOperation({
    beforeDispatch: async () => {
      await branch.view.updateInvocation(id, {phase: 'dispatching'}); controller.signal.throwIfAborted();
      if (historyGuidance) await injectLocalizationPreservation({rpc:branch.rpc,forkId:branch.forkId,sourceThreadId,
        purpose:branch.purpose,guidance:nativePreservationInstructions,signal:controller.signal});
    },
    dispatch: onDispatch => branch.session.compact(controller.signal, async evidence => {
      if (evidence.kind === 'snapshot') await branch.journal.usageSnapshot({operationId: branch.operationId, sourceKey: `native-localization-${branch.label}`, sourceEpoch: `localization-${branch.label}`, generation: 0, ...evidence, completenessReason: 'compaction_observed'});
      else { branch.unknownUsage = true; await branch.journal.usageGap({operationId: branch.operationId, sourceKey: `native-localization-${branch.label}`, sourceEpoch: `localization-${branch.label}`, generation: 0, ...evidence}); }
    }, onDispatch),
    terminal: (state, result) => branch.journal.operationTerminal({operationId: branch.operationId, admissionId: id, ownerUuid: branch.ownerUuid, sourceKey: `native-localization-${branch.label}`, sourceEpoch: `localization-${branch.label}`, generation: 0, ...(result?.turnId ? {turnId: result.turnId} : {}), terminalState: state, usageCompleteness: result?.usageCompleteness ?? (state === 'cancelled' ? 'cancelled_before_dispatch' : 'protocol_failed'), operationKind: 'context_compression'}),
    settleConfirmed: async () => { await branch.view.updateInvocation(id, {phase: 'settling', cleanupOutcome: 'pending'}); await branch.view.settle(id, null, 'confirmed_compression_unknown'); },
    settleUnconfirmed: async () => { await branch.view.settle(id, null, 'unsafe_unknown'); },
    cancelBeforeDispatch: async () => { await branch.view.cancelBeforeDispatch(id); },
  });
  if (!branch.compactionEvidence || !branch.forkPath) throw Error('LOCALIZATION_COMPACTION_EVIDENCE_MISSING');
  const storage = createNativeStorage(resolve(config.parentDirectory, 'observer-auth'));
  const read = await readOwnedNativeCheckpoint({runtimeHome: resolve(config.parentDirectory, 'observer-auth'), path: branch.forkPath, sourceThreadId, forkThreadId: branch.forkId, custodyTag: branch.claim.tag, maxBytes: 2 * 1024 * 1024, verifyStorage: () => storage.verify(controller.signal)});
  const {pinNativeLocalizationCheckpoint} = await localizationApi();
  const pin = pinNativeLocalizationCheckpoint({envelope: read.envelope, checkpointFingerprint: read.checkpoint.fingerprint, compactionTurnId: branch.compactionEvidence.turnId, compactionItemId: branch.compactionEvidence.itemId, observedAt: branch.compactionEvidence.completedAt});
  branch.reportEntry.checkpoint = {envelopeHash: pin.envelopeHash, checkpointFingerprint: pin.checkpointFingerprint, compactionTurnId: pin.compactionTurnId, compactionItemId: pin.compactionItemId, observedAt: pin.observedAt};
  return pin;
}

try {
  await mkdir(sourceDay, {recursive: true});
  const account = await identity.inspect(controller.signal);
  gate.update(account.evidence);
  if (!gate.accept(gate.offer())) throw Error('TRIAL_CONSENT_UNAVAILABLE');
  expectedBinding = JSON.stringify(bindingOf(account));
  const assets = await loadObserverApiAssets(resourcesDirectory);
  await writeFile(sourcePath, frozenSource.rollout, {flag: 'wx', mode: 0o600});
  if (!run) {
    report.checks.push({name: 'synthetic_source_hash', ok: hash(await readFile(sourcePath)) === frozenSource.sourceHash});
    report.checks.push({name: 'framing_tail_excludes_response_items', ok: !sourceFramingTail.includes('response_item')});
    report.checks.push({name: 'no_history_argument', ok: process.argv.length === 5});
  } else {
    const storage = createNativeStorage(resolve(config.parentDirectory, 'observer-auth'));
    await storage.prepare(controller.signal);
    const authority = await openApprovedNativeLocalizationSeries({runtimeHome: resolve(config.parentDirectory, 'observer-auth'), binding: bindingOf(account), verifyStorage: () => storage.verify(controller.signal)});
    report.approvedTrialId = authority.approvedTrialId;
    budget = authority.budget;
    ledger = await openReleaseAccounting(authority.ledgerDirectory, Date.now);
    const commonInput = {goalSummary: raw.sourceGoal, activeSeconds: 10, runtime: 'running', messages: [{kind: 'user', text: raw.requestText, truncated: false}], truncated: false};

    await phase('A-raw-fork-eta', async () => {
      const branch = await openBranch('A', frozenSource.rollout, frozenSource.currentTurnId, 1, assets, branchRegistry);
      await probe(branch, commonInput);
      report.checks.push({name: 'A_source_unchanged', ok: hash(await readFile(sourcePath)) === frozenSource.sourceHash});
      await closeBranch(branch); branchRegistry.untrack(branch);
    });

    const bRollout = frozenSource.rollout;
    const b = await phase('B-raw-fork-explicit-compaction', async () => {
      const branch = await openBranch('B', bRollout, frozenSource.currentTurnId, 2, assets, branchRegistry);
      const pin = await explicitCompression(branch);
      const preProbeBudget = budget.snapshot();
      await probe(branch, commonInput);
      if (budget.snapshot().compaction !== preProbeBudget.compaction || report.automaticCompactions !== 0) throw Error('LOCALIZATION_EXTRA_COMPACTION');
      const storageAgain = createNativeStorage(resolve(config.parentDirectory, 'observer-auth'));
      const after = await readOwnedNativeCheckpoint({runtimeHome: resolve(config.parentDirectory, 'observer-auth'), path: branch.forkPath, sourceThreadId, forkThreadId: branch.forkId, custodyTag: branch.claim.tag, maxBytes: 2 * 1024 * 1024, verifyStorage: () => storageAgain.verify(controller.signal)});
      const {assertNativeLocalizationCheckpointUnchanged} = await localizationApi();
      assertNativeLocalizationCheckpointUnchanged(pin, {envelope: after.envelope, checkpointFingerprint: after.checkpoint.fingerprint, compactionTurnId: pin.compactionTurnId, compactionItemId: pin.compactionItemId, observedAt: pin.observedAt});
      report.checks.push({name: 'B_compacted_checkpoint_unchanged_after_probe', ok: true});
      await closeBranch(branch); branchRegistry.untrack(branch);
      return pin;
    });

    const cRollout = buildPinnedLocalizationSource({metadata: frozenSource.metadata, pin: b, framingTail: frozenSource.framingTail});
    await phase('C-pinned-checkpoint-import-eta', async () => {
      const branch = await openBranch('C', cRollout, fixtures[2].currentTurnId, 3, assets, branchRegistry);
      await probe(branch, {...commonInput, goalSummary: fixtures[2].sourceGoal});
      report.checks.push({name: 'C_source_is_pinned_envelope_plus_frozen_framing', ok: cRollout === buildPinnedLocalizationSource({metadata: frozenSource.metadata, pin: b, framingTail: frozenSource.framingTail})});
      await closeBranch(branch); branchRegistry.untrack(branch);
    });
  }
} catch (error) {
  failStop(error?.code ?? error?.message ?? 'SYNTHETIC_LOCALIZATION_FAILED', error?.localizationPhase ?? activePhase);
  process.exitCode = 1;
} finally {
  const cleanupErrors = await branchRegistry.closeAll(closeBranch);
  if (cleanupErrors.length > 0) { report.errors.push('TRIAL_CLEANUP_UNCONFIRMED'); process.exitCode = 1; }
  for (const owner of owners) if (owner.status().closed !== true) owner.disable();
  await Promise.all(automaticWrites);
  try { await identity.close(); } catch { report.errors.push('TRIAL_IDENTITY_CLOSE_UNCONFIRMED'); process.exitCode = 1; }
  if (budget) {try{report.budget = budget.snapshot(); await budget.close();}catch{report.errors.push('TRIAL_BUDGET_CLOSE_FAILED');}}
  if (ledger) {
    try{
    const accountingSnapshot = await captureLocalizationAccounting(ledger);
    report.knownTokens = accountingSnapshot.knownTokens;
    report.unknownUsage = accountingSnapshot.unknown;
    report.accounting = accountingSnapshot;
    }catch{report.errors.push('TRIAL_ACCOUNTING_REPORT_FAILED');report.knownTokens=null;report.unknownUsage=null;}
  }
  report.cleanupConfirmed = branchRegistry.size() === 0 && [...owners].every(owner => owner.status().closed === true);
  if (report.errors.length || !report.cleanupConfirmed) process.exitCode = 1;
  const artifact = join(root, run ? 'native-compression-localization.json' : `preflight-${Date.now()}.json`);
  await writeFile(artifact, JSON.stringify(report, null, 2), {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({artifact, mode, checks: report.checks, errors: report.errors, budget: report.budget, accounting: report.accounting, cleanupConfirmed: report.cleanupConfirmed}, null, 2));
}

}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
