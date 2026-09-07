import { describe, expect, it } from "vitest";
import { classifyLifecycle } from "../../src/lifecycle/classify.js";
import type { HudHealth, LifecycleObservation, ObservedHudState } from "../../src/lifecycle/types.js";

const compatibleHealth: HudHealth = {
  service: "codex-progress-hud",
  pid: 4312,
  version: "0.1.0",
  protocolVersion: 3,
  visibility: "visible",
  instanceNonce: "nonce-123",
  startedAt: "2026-09-01T01:02:03.000Z"
};

describe("lifecycle classification", () => {
  it.each<[LifecycleObservation, ObservedHudState]>([
    [
      {
        desiredState: "off",
        starting: true,
        identity: { service: "other", protocolVersion: 99 },
        hadHealthyRuntime: true
      },
      "stopped"
    ],
    [
      {
        desiredState: "on",
        starting: true,
        identity: { service: "other", protocolVersion: 99 },
        hadHealthyRuntime: true
      },
      "starting"
    ],
    [
      {
        desiredState: "on",
        starting: false,
        identity: { service: "other", protocolVersion: 3 },
        hadHealthyRuntime: false
      },
      "port_conflict"
    ],
    [
      {
        desiredState: "on",
        starting: false,
        identity: { service: "codex-progress-hud", protocolVersion: 99 },
        hadHealthyRuntime: false
      },
      "incompatible"
    ],
    [
      {
        desiredState: "on",
        starting: false,
        health: compatibleHealth,
        hadHealthyRuntime: true
      },
      "running"
    ],
    [
      {
        desiredState: "on",
        starting: false,
        health: { ...compatibleHealth, visibility: "hidden" },
        hadHealthyRuntime: true
      },
      "hidden"
    ],
    [
      {
        desiredState: "on",
        starting: false,
        hadHealthyRuntime: true
      },
      "crashed"
    ],
    [
      {
        desiredState: "on",
        starting: false,
        hadHealthyRuntime: false
      },
      "stopped"
    ]
  ])("classifies %o as %s", (input, expected) => {
    expect(classifyLifecycle(input)).toBe(expected);
  });

  it.each<[LifecycleObservation, ObservedHudState]>([
    [
      {
        desiredState: "on",
        starting: false,
        identity: { service: "other", protocolVersion: 99 },
        health: compatibleHealth,
        hadHealthyRuntime: true
      },
      "port_conflict"
    ],
    [
      {
        desiredState: "on",
        starting: false,
        identity: { service: "codex-progress-hud", protocolVersion: 99 },
        health: compatibleHealth,
        hadHealthyRuntime: true
      },
      "incompatible"
    ]
  ])("prefers identity conflict when classifying %o", (input, expected) => {
    expect(classifyLifecycle(input)).toBe(expected);
  });
});
