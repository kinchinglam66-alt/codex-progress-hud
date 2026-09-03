import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASE_CAPABILITIES } from "../../src/generated/capabilities.js";

const root = resolve(import.meta.dirname, "../..");

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(root, path), "utf8")) as Record<string, unknown>;
}

describe("release capabilities", () => {
  it("keeps the generated identity aligned with both package manifests", async () => {
    const packageManifest = await readJson("package.json");
    const pluginManifest = await readJson(".codex-plugin/plugin.json");

    expect(RELEASE_CAPABILITIES.product).toBe("codex-progress-hud");
    expect(RELEASE_CAPABILITIES.buildVersion).toMatch(/\S/);
    expect(RELEASE_CAPABILITIES.protocol.current).toBeGreaterThanOrEqual(
      RELEASE_CAPABILITIES.protocol.minimumClient
    );
    expect(RELEASE_CAPABILITIES.protocol.current).toBeLessThanOrEqual(
      RELEASE_CAPABILITIES.protocol.maximumClient
    );
    expect(RELEASE_CAPABILITIES.features.length).toBeGreaterThan(0);
    expect(packageManifest.version).toBe(RELEASE_CAPABILITIES.buildVersion);
    expect(pluginManifest.version).toBe(RELEASE_CAPABILITIES.buildVersion);
  });
});
