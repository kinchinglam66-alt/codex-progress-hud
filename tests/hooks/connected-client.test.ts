import { expect, it } from "vitest";
import { createConnectedHookClient } from "../../src/hooks/client.js";
import type { HookEnvelope } from "../../src/hooks/schema.js";
const envelope: HookEnvelope = { schemaVersion: 2, taskHandle: "hud_aaaaaaaaaaaaaaaaaaaa", eventId: "evt_aaaaaaaaaaaaaaaaaaaa", sessionKey: "session_aaaaaaaaaaaaaaaaaaaa", hook: "Stop", receivedAt: 1 };

it("delivers using observed generation without acquiring ownership or starting a process", async () => {
  let delivered = false;
  const client = createConnectedHookClient({
    readSettings: async () => ({ generation: 7, desiredState: "on", startWithWindows: false }),
    progressClient: {
      status: async options => { expect(options?.generation).toBe(7); return { revision: 2 }; },
      submitHook: async (value, options) => { expect(value).toBe(envelope); expect(options?.revision).toBe(2); expect(options?.generation).toBe(7); delivered = true; }
    }
  });
  await client.post(envelope);
  expect(delivered).toBe(true);
});

it("respects explicit off without contacting the companion", async () => {
  const client = createConnectedHookClient({
    readSettings: async () => ({ generation: 7, desiredState: "off", startWithWindows: false }),
    progressClient: { status: async () => { throw new Error("must not contact"); }, submitHook: async () => { throw new Error("must not submit"); } }
  });
  await expect(client.post(envelope)).rejects.toMatchObject({ code: "MANUALLY_DISABLED" });
});

it("surfaces offline delivery without a startup attempt", async () => {
  let submissions = 0;
  const offline = new Error("offline");
  const client = createConnectedHookClient({
    readSettings: async () => ({ generation: 0, startWithWindows: false }),
    progressClient: { status: async () => { throw offline; }, submitHook: async () => { submissions++; } }
  });
  await expect(client.post(envelope)).rejects.toBe(offline);
  expect(submissions).toBe(0);
});
