import { randomBytes } from "node:crypto";

export type TaskAssociationSource = "explicit" | "mcp_lease";

export interface ResolvedTaskAssociation {
  taskHandle: string;
  source: TaskAssociationSource;
}

export function createFallbackTaskHandle(
  byteSource: (size: number) => Buffer = randomBytes
): string {
  return `hud_${byteSource(24).toString("base64url")}`;
}

export function resolveTaskAssociation(
  explicitTaskHandle: string | undefined,
  fallbackTaskHandle: string
): ResolvedTaskAssociation {
  return explicitTaskHandle === undefined
    ? { taskHandle: fallbackTaskHandle, source: "mcp_lease" }
    : { taskHandle: explicitTaskHandle, source: "explicit" };
}
