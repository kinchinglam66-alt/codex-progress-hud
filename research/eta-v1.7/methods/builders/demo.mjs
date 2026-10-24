// Entirely synthetic. These are not historical model inputs or reported results.
import {buildPair} from './canonical.mjs';
import {GOAL,TIME_BASIS} from './legacy-causal-input.mjs';
const events=[
 {id:1,phase:'started',atMs:1000,tool:'container_command',command:'inspect source',arguments:{command:'inspect source'}},
 {id:1,phase:'result_arrived',atMs:5000,tool:'container_command',result:{stdout:'Synthetic source listing',stderr:'',exitCode:0,outputComplete:true}},
 {id:2,phase:'started',atMs:20000,tool:'container_command',command:'run synthetic test',arguments:{command:'run synthetic test'}},
 {id:2,phase:'result_arrived',atMs:61000,tool:'container_command',result:{stdout:'Synthetic assertion failed',stderr:'',exitCode:1,outputComplete:true}},
 {id:3,phase:'started',atMs:70000,tool:'container_command',command:'inspect fixture',arguments:{command:'inspect fixture',unsupportedOption:true}},
 {id:3,phase:'result_arrived',atMs:71000,tool:'container_command',result:{executionStarted:false,errorCode:'SYNTHETIC_ARGUMENT_ERROR',message:'Synthetic command was not executed.',outputComplete:true}},
 {id:4,phase:'started',atMs:175000,tool:'container_command',command:'validate synthetic repair',arguments:{command:'validate synthetic repair'}},
 {id:4,phase:'result_arrived',atMs:181000,tool:'container_command',result:{stdout:'Synthetic future result',stderr:'',exitCode:0,outputComplete:true}}
];
const pairs=[5,60,180].map(seconds=>({synthetic:true,seconds,...buildPair({initial:'Synthetic example: repair an invented boundary-condition error and report the result.',goal:GOAL,timeBasis:TIME_BASIS,ledger:{events},zero:0,seconds})}));
console.log(JSON.stringify({synthetic:true,historicalPredictions:false,pairs},null,2));
