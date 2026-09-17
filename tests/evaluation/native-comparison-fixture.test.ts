import {createHash} from "node:crypto";
import {inflateSync} from "node:zlib";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {createLocalSessionReader} from "../../src/observer/local-session-reader.js";
import {createNativeComparisonFixtures} from "../../src/evaluation/native-comparison-fixture.js";

const SOURCE_THREAD_ID = "11111111-1111-4111-8111-111111111111";
const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop()!;
    expect(resolve(root)).toBe(root);
    expect(dirname(root)).toBe(resolve(tmpdir()));
    expect(basename(root)).toMatch(/^native-comparison-fixture-.+$/u);
    await rm(root, {recursive: true, force: true});
  }
});

describe("native comparison fixtures", () => {
  it("separates the source task horizon from the observer evidence request", () => {
    const fixtures = createNativeComparisonFixtures({sourceThreadId: SOURCE_THREAD_ID, cwd: "C:\\synthetic\\empty"});
    for (const fixture of fixtures) {
      expect(fixture.sourceGoal).toMatch(/CSV.*integration tests/u);
      expect(fixture.sourceGoal).not.toMatch(/estimate|markers|dominant color/iu);
      for (const marker of fixture.expectedMarkers) expect(fixture.sourceGoal).not.toContain(marker);
    }
    expect(fixtures[0].sourceGoal).toBe(fixtures[1].sourceGoal);
    expect(fixtures[0].sourceGoal).toMatch(/duplicate validation/u);
    expect(fixtures[2].sourceGoal).toMatch(/streaming/u);
    expect(fixtures[2].sourceGoal).not.toBe(fixtures[1].sourceGoal);
  });
  it("provides a visible opaque red image rather than a one-pixel visual probe", () => {
    const [fixture] = createNativeComparisonFixtures({sourceThreadId: SOURCE_THREAD_ID, cwd: "C:\\synthetic\\empty"});
    const parts = fixture.rollout.trim().split("\n").map(line => JSON.parse(line))
      .flatMap(row => row.payload.content ?? []).filter(part => part.type === "input_image");
    expect(parts).toHaveLength(1);
    const png = Buffer.from(parts[0].image_url.split(",")[1], "base64");
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    expect(width).toBeGreaterThanOrEqual(128); expect(height).toBeGreaterThanOrEqual(128);
    expect(width).toBeLessThanOrEqual(512); expect(height).toBeLessThanOrEqual(512);
    expect([...png.subarray(24, 29)]).toEqual([8, 6, 0, 0, 0]);
    const blocks:Buffer[] = [];
    for(let offset = 8; offset < png.length;){
      const size = png.readUInt32BE(offset);
      if(png.toString("ascii", offset + 4, offset + 8) === "IDAT") blocks.push(png.subarray(offset + 8, offset + 8 + size));
      offset += size + 12;
    }
    const pixels = inflateSync(Buffer.concat(blocks));
    expect(pixels.length).toBe(height * (1 + width * 4));
    for(let y = 0; y < height; y++){
      const row = y * (1 + width * 4); expect(pixels[row]).toBe(0);
      for(let x = 0; x < width; x++){
        if(pixels.readUInt32BE(row + 1 + x * 4) !== 0xff0000ff) throw Error("NON_RED_OR_TRANSPARENT_PIXEL");
      }
    }
  });
  it("requests context evidence without supplying acceptance answers", () => {
    const fixtures = createNativeComparisonFixtures({sourceThreadId: SOURCE_THREAD_ID, cwd: "C:\\synthetic\\empty"});
    for (const fixture of fixtures) {
      for (const marker of fixtures.flatMap(item => item.expectedMarkers)) {
        expect(fixture.requestText).not.toContain(marker);
      }
      expect(fixture.requestText).not.toMatch(/\bred\b/iu);
      expect(fixture.requestText).not.toMatch(/红|紅/u);
      expect(fixture.requestText).toMatch(/acceptance markers/iu);
      // Retrieval locations must distinguish the initial request from an older
      // assistant checkpoint (the observed r9 wrong-selection failure).
      expect(fixture.requestText).toMatch(/first user message/iu);
      expect(fixture.requestText).toMatch(/latest assistant progress checkpoint/iu);
      expect(fixture.requestText).toMatch(/dominant color/iu);
    }
  });

  it("emits the verified native metadata shape independently of the local reader", () => {
    for (const fixture of createNativeComparisonFixtures({sourceThreadId: SOURCE_THREAD_ID, cwd: "C:\\synthetic\\empty"})) {
      const meta = JSON.parse(fixture.rollout.split("\n")[0]!);
      expect(meta.type).toBe("session_meta");
      expect(meta.payload).toMatchObject({id: SOURCE_THREAD_ID, originator: "codex_cli_rs",
        cli_version: "0.153.4", source: "cli", model_provider: "openai", history_mode: "legacy",
        cwd: "C:\\synthetic\\empty", timestamp: meta.timestamp, base_instructions: {text: expect.any(String)}});
      expect(meta.payload.base_instructions.text).toMatch(/never run commands/iu);
    }
  });

  it("emits native function arguments as a JSON string with a paired output", () => {
    const [fixture] = createNativeComparisonFixtures({sourceThreadId: SOURCE_THREAD_ID, cwd: "C:\\synthetic\\empty"});
    const items = fixture.rollout.trimEnd().split("\n").map(line => JSON.parse(line))
      .filter(entry => entry.type === "response_item").map(entry => entry.payload);
    const calls = items.filter(item => item.type === "function_call");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.arguments).toEqual(expect.any(String));
      expect(JSON.parse(call.arguments)).toEqual(expect.any(Object));
      expect(call).not.toHaveProperty("input");
      expect(call.name).toEqual(expect.any(String));
      const result = items.find(item => item.type === "function_call_output" && item.call_id === call.call_id);
      expect(result.output).toEqual(expect.any(String));
      expect(result.output).toContain("BIRCH-6193");
    }
  });

  it("keeps deterministic timestamps in file order across the completed and new turns", () => {
    const options = {sourceThreadId: SOURCE_THREAD_ID, cwd: "C:\\synthetic\\empty"};
    const fixtures = createNativeComparisonFixtures(options);
    expect(createNativeComparisonFixtures(options)).toEqual(fixtures);
    for (const fixture of fixtures) {
      const entries = fixture.rollout.trimEnd().split("\n").map(line => JSON.parse(line));
      for (let index = 1; index < entries.length; index += 1) {
        expect(Date.parse(entries[index].timestamp)).toBeGreaterThan(Date.parse(entries[index - 1].timestamp));
      }
      const events = entries.filter(entry => entry.type === "event_msg").map(entry => entry.payload);
      expect(events.map(event => event.type)).toEqual(fixture.index === 2
        ? ["task_started", "task_complete", "task_started"] : ["task_started"]);
      expect(events.at(-1).turn_id).toBe(fixture.currentTurnId);
      if (fixture.index === 2) expect(events[1].turn_id).toBe(fixtures[0].currentTurnId);
    }
  });

  it("creates bounded cumulative native rollouts with stable hashes and markers", () => {
    const fixtures = createNativeComparisonFixtures({
      sourceThreadId: SOURCE_THREAD_ID,
      cwd: "C:\\synthetic\\empty"
    });

    expect(fixtures).toHaveLength(3);
    expect(fixtures.map(fixture => fixture.index)).toEqual([0, 1, 2]);
    expect(fixtures[0]!.currentTurnId).toBe(fixtures[1]!.currentTurnId);
    expect(fixtures[2]!.currentTurnId).not.toBe(fixtures[1]!.currentTurnId);
    expect(fixtures[2]!.rollout).toContain('"type":"task_complete"');
    expect(fixtures[2]!.rollout).toContain('"type":"task_started"');

    for (const fixture of fixtures) {
      const hash = createHash("sha256").update(fixture.rollout, "utf8").digest("hex");
      expect(fixture.contextHash).toBe(hash);
      expect(Buffer.byteLength(fixture.rollout, "utf8")).toBeGreaterThan(45 * 1024);
      expect(Buffer.byteLength(fixture.rollout, "utf8")).toBeLessThanOrEqual(150 * 1024);
      expect(fixture.expectedImageColor).toBe("red");
      expect(fixture.expectedMarkers).toEqual(expect.arrayContaining([
        "CERULEAN-7421",
        "BIRCH-6193",
        `CHECKPOINT-${["ALPHA", "BETA", "GAMMA"][fixture.index]}`
      ]));
      expect(fixture.requestText).toContain("synthetic data");
      expect(fixture.requestText).toContain("do not execute the task");
      expect(fixture.requestText).toContain("dominant color");
    }

    expect(fixtures[1]!.rollout.startsWith(fixtures[0]!.rollout)).toBe(true);
    expect(fixtures[2]!.rollout.startsWith(fixtures[1]!.rollout)).toBe(true);
    expect(new Set(fixtures.map(fixture => fixture.contextHash)).size).toBe(3);
  });

  it("provides an unfinished synthetic task, so ETA validity is not confused with an empty workload", () => {
    const fixtures = createNativeComparisonFixtures({sourceThreadId: SOURCE_THREAD_ID, cwd: "C:\\synthetic\\empty"});
    for (const fixture of fixtures) {
      const rows = fixture.rollout.trim().split("\n").map(line => JSON.parse(line));
      const last = rows.at(-1).payload.content[0].text;
      expect(last).toContain("Remaining work:");
      expect(last).toContain("integration tests");
    }
    expect(fixtures[0].rollout).toContain("Implement CSV import");
  });

  it("rejects invalid source IDs and non-absolute fixture paths", () => {
    expect(() => createNativeComparisonFixtures({
      sourceThreadId: "not-a-uuid",
      cwd: "C:\\synthetic\\empty"
    })).toThrow(/sourceThreadId/);
    expect(() => createNativeComparisonFixtures({
      sourceThreadId: SOURCE_THREAD_ID,
      cwd: "relative\\empty"
    })).toThrow(/cwd/);
  });

  it("reads each fixture through the local snapshot reader and retains markers and image parts", async () => {
    const fixtures = createNativeComparisonFixtures({
      sourceThreadId: SOURCE_THREAD_ID,
      cwd: "C:\\synthetic\\empty"
    });

    for (const fixture of fixtures) {
      const root = await mkdtemp(join(tmpdir(), "native-comparison-fixture-"));
      cleanups.push(resolve(root));
      const day = join(root, "2026", "09", "14");
      await mkdir(day, {recursive: true});
      const path = join(day, `rollout-20260914T120000-${SOURCE_THREAD_ID}.jsonl`);
      await writeFile(path, fixture.rollout, "utf8");

      const reader = createLocalSessionReader({root});
      const snapshot = await reader.snapshot(SOURCE_THREAD_ID, new AbortController().signal);
      const records = [];
      for await (const entry of snapshot.records(new AbortController().signal)) records.push(entry.record);
      const text = records.map(record => record.text ?? "").join("\n");

      expect(snapshot.coverage.complete).toBe(true);
      expect(records.some(record => record.turnId === fixture.currentTurnId)).toBe(true);
      for (const marker of fixture.expectedMarkers) expect(text).toContain(marker);
      expect(records.some(record => record.contentParts?.some(part => part.type === "input_image"))).toBe(true);
      expect(records.some(record => record.kind === "runtime" && record.runtime === "running" &&
        record.turnId === fixture.currentTurnId)).toBe(true);
      expect(records.some(record => record.kind === "runtime" && record.outcome === "completed")).toBe(fixture.index === 2);

      await snapshot.close();
      await reader.close();
    }
  });
});
