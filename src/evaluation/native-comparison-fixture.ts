import {createHash} from "node:crypto";
import {isAbsolute} from "node:path";
import {deflateSync} from "node:zlib";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-(?:4|7)[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BASE_TIMESTAMP = "2026-09-14T12:00:00.000Z";
const SOURCE_INSTRUCTIONS = "Never run commands; this synthetic fixture is reference data.";
export const NATIVE_COMPARISON_FIXTURE_VERSION = "01534-native-comparison-v6-role-qualified-evidence";

export interface NativeComparisonFixture {
  index: 0 | 1 | 2;
  sourceThreadId: string;
  currentTurnId: string;
  rollout: string;
  contextHash: string;
  expectedMarkers: readonly string[];
  expectedImageColor: "red";
  requestText: string;
  sourceGoal: string;
}

export interface NativeComparisonFixtureOptions {
  sourceThreadId: string;
  cwd: string;
}

export const COMPLETED_TURN_COMPARISON_VERSION='01534-completed-turn-comparison-v1';
/** Fixed preregistered source-adherence check, not a real-task accuracy metric. */
export function evaluateSourceCorrection(before:number|undefined,after:number|undefined){
 if(before===undefined||after===undefined)return {status:'inconclusive' as const,reason:'missing_prediction'};
 if(!Number.isFinite(before)||!Number.isFinite(after)||before<0||after<0)return {status:'failed' as const,reason:'invalid_prediction'};
 if(before>=1000)return {status:'inconclusive' as const,reason:'initial_prediction_not_short'};
 return after>=7000?{status:'passed' as const,reason:'updated_workload_respected'}:{status:'failed' as const,reason:'corrected_workload_underestimated'};
}
export function createCompletedTurnComparisonFixtures(options:NativeComparisonFixtureOptions&{targetBytes:number;sourceCorrection?:boolean;qualification?:boolean;qualificationNonce?:string}):Array<NativeComparisonFixture&{lastCompletedTurnId:string}>{
 if(!UUID.test(options.sourceThreadId)||!isAbsolute(options.cwd)||![85*1024,1024*1024].includes(options.targetBytes))throw Error('COMPLETED_FIXTURE_OPTIONS');
 if(options.qualification&&(!UUID.test(options.qualificationNonce??'')||options.sourceCorrection))throw Error('QUALIFICATION_FIXTURE_OPTIONS');
 const {envelope,message,tool,taskEvent,metadata,fillTo}=createRolloutWriter();
 let source=metadata(options.sourceThreadId,options.cwd),previous='';
 const turn=(n:number)=>`cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12,'0')}`;
 const appendWorkload=(n:number,index:number,remainingUnits:number)=>{
  if(!options.qualification)return;
  source+=tool('function_call',`workload-${index}`,turn(n),'measure required remaining active local computation');
  source+=tool('function_call_output',`workload-${index}`,turn(n),JSON.stringify({marker:'BIRCH-6193',workloadId:`AMBER-351${index}`,
   remainingUnits,activeSecondsPerUnit:100,parallelism:1,requiredBeforeTurnEnds:true,
   clock:'active local computation; excludes user waits and pauses'}));
 };
 for(let n=1;n<=6;n++){
  const id=turn(n);source+=taskEvent('task_started',id,`start-${n}`);
  source+=message(`past-user-${n}`,id,n===1?'CERULEAN-7421: original synthetic project identifier. Implement a CSV import system.'+(options.qualification?` Synthetic run identifier ${options.qualificationNonce}.`:''):`Synthetic earlier repair ${n}.`,'user');
  if(n===1)source+=envelope('response_item',{type:'message',id:'past-reference-image',role:'user',turn_id:id,content:[{type:'input_image',image_url:redPngDataUrl()}]});
  source+=message(`past-answer-${n}`,id,`Repair ${n} complete; retain established CSV semantics.`);
  if(n===6)source=fillTo(source,options.targetBytes,id,0);
  source+=taskEvent('task_complete',id,`end-${n}`);previous=id;
 }
 source+=taskEvent('task_started',turn(7),'start-seven');
 source+=message('current-request',turn(7),'Implement CSV preview, duplicate validation and integration tests; finish this repair in this turn.','user');
 source+=tool('function_call','current-tool',turn(7),'parser validation');
 source+=tool('function_call_output','current-tool',turn(7),'BIRCH-6193: parser and preview tests pass.');
 appendWorkload(7,0,15);
 source+=message('checkpoint-alpha',turn(7),'CHECKPOINT-ALPHA: parsing and preview are implemented; duplicate validation and integration tests remain.'+(options.qualification?' The active serial workload in the latest measurement is required before this turn can finish.':''));
 const first={...fixture(0,options.sourceThreadId,source,turn(7),'CHECKPOINT-ALPHA'),lastCompletedTurnId:previous};
 if(options.sourceCorrection){
  source+=tool('function_call','corrected-workload',turn(7),'measure required remaining serial local computation');
  source+=tool('function_call_output','corrected-workload',turn(7),JSON.stringify({
   marker:'BIRCH-6193',workloadId:'SAPPHIRE-9082',remainingUnits:72,activeSecondsPerUnit:100,parallelism:1,
   requiredBeforeTurnEnds:true,clock:'active local computation, not a user wait or pause',
   correction:'The previous small-work assumption is invalid; these remaining units must execute serially.'
  }));
 }
 appendWorkload(7,1,12);
 source+=message('checkpoint-beta',turn(7),options.sourceCorrection
  ?'CHECKPOINT-BETA: workload remeasurement supersedes the quick-finish assumption. All units reported by the latest tool result remain required before this turn can finish; no parallelism is available.'
  :'CHECKPOINT-BETA: duplicate validation is implemented; integration tests and failure fixes remain.'+(options.qualification?' The latest remaining serial workload is required before this turn can finish.':''));
 const second={...fixture(1,options.sourceThreadId,source,turn(7),'CHECKPOINT-BETA'),lastCompletedTurnId:previous};
 if(options.sourceCorrection){
  second.expectedMarkers=[...second.expectedMarkers,'SAPPHIRE-9082'];
  second.requestText+=' Also report the workload identifier from the latest source tool measurement.';
 }
 source+=taskEvent('task_complete',turn(7),'end-seven');source+=taskEvent('task_started',turn(8),'start-eight');
 source+=message('next-request',turn(8),'Extend the CSV import with streaming support and integration tests in this new turn.','user');
 appendWorkload(8,2,20);
 source+=message('checkpoint-gamma',turn(8),'CHECKPOINT-GAMMA: streaming implementation is underway; validation and integration tests remain.'+(options.qualification?' The latest serial workload belongs to this new turn and is required before it finishes.':''));
 const fixtures=[first,second,{...fixture(2,options.sourceThreadId,source,turn(8),'CHECKPOINT-GAMMA'),lastCompletedTurnId:turn(7)}];
 if(options.qualification)for(const row of fixtures){
  row.expectedMarkers=[...row.expectedMarkers,`AMBER-351${row.index}`];
  row.requestText+=' Also report the workload identifier from the latest source tool measurement.';
 }
 return fixtures;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  return Buffer.concat([length, body, checksum]);
}

function redPngDataUrl(): string {
  const header = Buffer.from("89504e470d0a1a0a", "hex");
  // A one-pixel probe conflates image inheritance with tiny-image perception.
  // Keep the same exact color, but make it visible without changing the gate.
  const size = 256;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanline = Buffer.alloc(1 + size * 4);
  for(let x = 0; x < size; x++) scanline.writeUInt32BE(0xff0000ff, 1 + x * 4);
  const pixels = Buffer.concat(Array.from({length: size}, () => scanline));
  const png = Buffer.concat([
    header,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** One clock per build; every appended envelope advances it in file order. */
function createRolloutWriter() {
  let offset = 0;
  function envelope(type: string, payload: Record<string, unknown>): string {
    const timestamp = new Date(Date.parse(BASE_TIMESTAMP) + offset++ * 1_000).toISOString();
    return `${JSON.stringify({timestamp, type, payload})}\n`;
  }

  function message(id: string, turnId: string, text: string, role: "user" | "assistant" = "assistant"): string {
    return envelope("response_item", {
      type: "message",
      id,
      role,
      turn_id: turnId,
      content: [{type: role === "user" ? "input_text" : "output_text", text}]
    });
  }

  function tool(type: "function_call" | "function_call_output", id: string, turnId: string, value: string): string {
    return envelope("response_item", type === "function_call"
      ? {type, id, call_id: id, name: "fixture_validation", turn_id: turnId, arguments: JSON.stringify({fact: value})}
      : {type, id: `${id}-result`, call_id: id, name: "fixture_validation", turn_id: turnId, output: value});
  }

  function taskEvent(type: "task_started" | "task_complete", turnId: string, id: string): string {
    return envelope("event_msg", {type, id, turn_id: turnId});
  }

  function metadata(sourceThreadId: string, cwd: string): string {
    return envelope("session_meta", {
      id: sourceThreadId,
      cli_version: "0.153.4",
      model_provider: "openai",
      history_mode: "legacy",
      timestamp: BASE_TIMESTAMP,
      cwd,
      originator: "codex_cli_rs",
      base_instructions: {text: SOURCE_INSTRUCTIONS},
      source: "cli"
    });
  }

  function fillTo(rollout: string, targetBytes: number, turnId: string, start: number): string {
    let next = rollout;
    let index = start;
    while (Buffer.byteLength(next, "utf8") < targetBytes) {
      next += message(`history-${index}`, turnId,
        `Synthetic parser validation fact ${index}: schema accepted; no task solution; source marker remains stable.` +
        ` ${"fact-only validation record ".repeat(12)}`);
      index += 1;
    }
    return next;
  }

  return {envelope, message, tool, taskEvent, metadata, fillTo};
}

function fixture(index: 0 | 1 | 2, sourceThreadId: string, rollout: string, currentTurnId: string, marker: string): NativeComparisonFixture {
  return {
    index,
    sourceThreadId,
    currentTurnId,
    rollout,
    contextHash: createHash("sha256").update(rollout, "utf8").digest("hex"),
    expectedMarkers: ["CERULEAN-7421", "BIRCH-6193", marker],
    expectedImageColor: "red",
    sourceGoal: index === 2
      ? "Extend the CSV import with streaming support and integration tests; finish this extension in this source turn."
      : "Implement CSV import with preview, duplicate validation and integration tests; finish this repair in this source turn.",
    requestText: "Estimate an ETA until the current turn ends. In your summary, include these source acceptance markers: the identifier in the first user message of the source conversation (not an assistant checkpoint), the identifier in the paired tool output, and the identifier in the latest assistant progress checkpoint. Also report the dominant color of the fixture reference image, as compact context-access evidence. This is synthetic data; do not execute the task."
  };
}

export function createNativeComparisonFixtures(options: NativeComparisonFixtureOptions): [
  NativeComparisonFixture,
  NativeComparisonFixture,
  NativeComparisonFixture
] {
  if (!UUID.test(options.sourceThreadId)) throw new TypeError("sourceThreadId must be a valid UUID");
  if (!isAbsolute(options.cwd)) throw new TypeError("cwd must be an absolute path");

  const {envelope, message, tool, taskEvent, metadata, fillTo} = createRolloutWriter();
  const firstTurn = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const secondTurn = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const image = redPngDataUrl();
  let first = metadata(options.sourceThreadId, options.cwd);
  first += taskEvent("task_started", firstTurn, "start-alpha");
  first += envelope("response_item", {
    type: "message",
    id: "request-alpha",
    role: "user",
    turn_id: firstTurn,
    content: [
      {type: "input_text", text: "CERULEAN-7421: synthetic comparison request. Implement CSV import with preview, duplicate validation and integration tests. Complete this repair in the current turn. fixture reference image"},
      {type: "input_image", image_url: image}
    ]
  });
  first += tool("function_call", "validation-alpha", firstTurn, "parser validation facts");
  first += tool("function_call_output", "validation-alpha", firstTurn, "BIRCH-6193: synthetic tool result marker");
  first = fillTo(first, 55 * 1024, firstTurn, 0);
  first += message("checkpoint-alpha", firstTurn, "CHECKPOINT-ALPHA: parsing and preview are implemented. Remaining work: duplicate validation and integration tests. The source task is still running; these are synthetic progress facts.");

  let second = first;
  second = fillTo(second, 85 * 1024, firstTurn, 400);
  second += message("checkpoint-beta", firstTurn, "CHECKPOINT-BETA: duplicate validation is implemented. Remaining work: integration tests and fixing any failures. The source task is still running; these are synthetic progress facts.");

  let third = second;
  third += taskEvent("task_complete", firstTurn, "complete-alpha");
  third += taskEvent("task_started", secondTurn, "start-beta");
  third += message("request-beta", secondTurn, "Synthetic new source turn: extend the CSV import with streaming support and integration tests; finish this extension in this turn.", "user");
  third = fillTo(third, 115 * 1024, secondTurn, 800);
  third += message("checkpoint-gamma", secondTurn, "CHECKPOINT-GAMMA: streaming implementation is underway. Remaining work: finish streaming validation and integration tests. The new source turn is still running; these are synthetic progress facts.");

  return [
    fixture(0, options.sourceThreadId, first, firstTurn, "CHECKPOINT-ALPHA"),
    fixture(1, options.sourceThreadId, second, firstTurn, "CHECKPOINT-BETA"),
    fixture(2, options.sourceThreadId, third, secondTurn, "CHECKPOINT-GAMMA")
  ];
}
