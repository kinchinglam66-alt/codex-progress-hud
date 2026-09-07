import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {expect,it} from "vitest";
const exec=promisify(execFile);
it("requires an explicit live opt-in and exact local inputs before any experiment side effects",async()=>{
  const result=await exec(process.execPath,["scripts/evaluation/run-controlled.mjs"],{cwd:process.cwd()}).catch(x=>x);
  expect(result.code).toBe(2);
  expect(result.stderr).toBe("CONTROLLED_EXPERIMENT_ARGUMENTS_REQUIRED\n");
});
