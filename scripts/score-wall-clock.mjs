// New-basis only. No models, network, mutations or legacy report relabelling.
// Build first, then: node scripts/score-wall-clock.mjs <controller-bundles.json>
import {readFile,stat} from 'node:fs/promises';
import {evaluateWallClockTask,summarizeWallClockTasks} from '../dist/evaluation/wall-clock-evaluation.js';
const input=process.argv[2];
if(!input||process.argv.length!==3)throw Error('usage: score-wall-clock.mjs <controller-bundles.json>');
if((await stat(input)).size>16*1024*1024)throw Error('evaluation_bundle_too_large');
const data=JSON.parse(await readFile(input,'utf8'));
if(!Array.isArray(data)||data.length>256)throw Error('expected_bounded_task_bundle_array');
const tasks=data.map(evaluateWallClockTask);
process.stdout.write(JSON.stringify({summary:summarizeWallClockTasks(tasks),tasks},null,2)+'\n');
