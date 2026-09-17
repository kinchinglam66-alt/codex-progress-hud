import {describe, expect, it} from "vitest";
import {
  assertNativeLocalizationCheckpointUnchanged,
  pinNativeLocalizationCheckpoint,
  runNativeLocalizationOperation,
  type NativeLocalizationCheckpointObservation,
} from "../../src/evaluation/native-compression-localization.js";

function observation(overrides: Partial<NativeLocalizationCheckpointObservation> = {}): NativeLocalizationCheckpointObservation {
  return {
    envelope: {
      type: "compacted",
      payload: {
        replacement_history: [
          {type: "message", role: "user", content: [{type: "input_text", text: "opaque"}]},
          {type: "compaction", encrypted_content: "opaque-summary"},
        ],
      },
    },
    checkpointFingerprint: "a".repeat(64),
    compactionTurnId: "turn-b",
    compactionItemId: "item-b",
    observedAt: 1737000000000,
    ...overrides,
  };
}

describe("native compression localization boundary", () => {
  it("pins an immutable envelope and its exact evidence identity", () => {
    const input = observation();
    const pin = pinNativeLocalizationCheckpoint(input);

    expect(pin.envelopeHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(pin.checkpointFingerprint).toBe(input.checkpointFingerprint);
    expect(pin.compactionTurnId).toBe("turn-b");
    expect(pin.compactionItemId).toBe("item-b");
    expect(Object.isFrozen(pin)).toBe(true);
    expect(Object.isFrozen(pin.envelope)).toBe(true);

    (input.envelope.payload as {replacement_history: Array<Record<string, unknown>>})
      .replacement_history[1]!.encrypted_content = "changed-after-pin";
    expect(() => assertNativeLocalizationCheckpointUnchanged(pin, input)).toThrow("NATIVE_LOCALIZATION_CHECKPOINT_CHANGED");
  });

  it("rejects an envelope change even when the parsed checkpoint fingerprint is unchanged", () => {
    const pin = pinNativeLocalizationCheckpoint(observation());
    const changed = observation({
      envelope: {
        type: "compacted",
        payload: {
          replacement_history: [
            {type: "message", role: "user", content: [{type: "input_text", text: "opaque"}]},
            {type: "compaction", encrypted_content: "opaque-summary"},
          ],
        },
        diagnostic_only_metadata: "changed-envelope",
      },
      checkpointFingerprint: pin.checkpointFingerprint,
    });

    expect(() => assertNativeLocalizationCheckpointUnchanged(pin, changed))
      .toThrow("NATIVE_LOCALIZATION_CHECKPOINT_CHANGED");
  });

  it("runs one admitted operation fail-stop and settles unknown after dispatch failure", async () => {
    const events: string[] = [];
    let dispatches = 0;

    await expect(runNativeLocalizationOperation({
      beforeDispatch: async () => { events.push("before-dispatch"); },
      dispatch: async onDispatch => {
        dispatches += 1;
        onDispatch();
        events.push("dispatch");
        throw new Error("synthetic-dispatch-failure");
      },
      terminal: async state => { events.push(`terminal:${state}`); },
      settleConfirmed: async () => { events.push("settle:confirmed"); },
      settleUnconfirmed: async () => { events.push("settle:unknown"); },
      cancelBeforeDispatch: async () => { events.push("cancel-before-dispatch"); },
    })).rejects.toThrow("synthetic-dispatch-failure");

    expect(dispatches).toBe(1);
    expect(events).toEqual(["before-dispatch", "dispatch", "terminal:unconfirmed", "settle:unknown"]);
  });

  it("does not classify a completed explicit compression with unknown usage as a failure", async () => {
    const events: string[] = [];
    const result = await runNativeLocalizationOperation({
      beforeDispatch: async () => { events.push("before-dispatch"); },
      dispatch: async onDispatch => {
        onDispatch();
        events.push("dispatch");
        return {terminalConfirmed: true, cancelled: false, usageCompleteness: "missing" as const};
      },
      terminal: async state => { events.push(`terminal:${state}`); },
      settleConfirmed: async () => { events.push("settle:confirmed-unknown"); },
      settleUnconfirmed: async () => { events.push("settle:unknown"); },
      cancelBeforeDispatch: async () => { events.push("cancel-before-dispatch"); },
    });

    expect(result.terminalConfirmed).toBe(true);
    expect(events).toEqual(["before-dispatch", "dispatch", "terminal:completed", "settle:confirmed-unknown"]);
  });
});
