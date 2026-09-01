import { PROTOCOL_VERSION } from "./types.js";
import type { LifecycleObservation, ObservedHudState } from "./types.js";

export function classifyLifecycle(input: LifecycleObservation): ObservedHudState {
  if (input.desiredState === "off") return "stopped";
  if (input.starting) return "starting";
  if (input.identity?.service !== undefined && input.identity.service !== "codex-progress-hud") return "port_conflict";
  if (input.identity?.protocolVersion !== undefined && input.identity.protocolVersion !== PROTOCOL_VERSION) return "incompatible";
  if (input.health !== undefined) return input.health.visibility === "visible" ? "running" : "hidden";
  return input.hadHealthyRuntime ? "crashed" : "stopped";
}
