import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_CALL_LIMIT,
  DEFAULT_MAX_OUTPUT_TOKENS,
  parseProviderConfig,
  readProviderConfig,
  saveProviderConfig,
  toPublicProviderConfig,
  resolveConfiguredCapacity,
  type ProviderConfig,
} from "../../src/desktop/observer-provider-config.js";

const api = {
  profileId: "api-1",
  name: "Synthetic test provider",
  baseUrl: "https://example.test/v1",
  protocol: "responses" as const,
  model: "synthetic-model",
  keyRef: "opaque-ref-1",
  maxOutputTokens: 2048,
  dailyCallLimit: 24,
};

const config: ProviderConfig = { version: 1, selected: "api", api };

describe("observer provider configuration", () => {
  it('preserves optional model-scoped capacity without changing credentials',()=>{
    const contextCapacity={model:api.model,contextTokens:100000,outputReserveTokens:4096,requestBytes:500000};
    const value={...config,contextCapacity};
    expect(parseProviderConfig(value)).toEqual(value);
    expect(toPublicProviderConfig(parseProviderConfig(value)).contextCapacity).toEqual(contextCapacity);
    expect(resolveConfiguredCapacity(parseProviderConfig(value),api.model,2048)).toEqual({
      contextTokens:100000,outputReserveTokens:4096,requestBytes:500000,source:'configured'});
    expect(resolveConfiguredCapacity(parseProviderConfig(value),'another-model',2048)).toBeNull();
    expect(resolveConfiguredCapacity(config,api.model,2048)).toBeNull();
    expect(resolveConfiguredCapacity(parseProviderConfig(value),api.model,100001)).toBeNull();
    expect(()=>parseProviderConfig({...value,contextCapacity:{...contextCapacity,outputReserveTokens:100000}})).toThrow();
  });
  it("accepts a complete API configuration and exposes editable starting defaults", () => {
    expect(parseProviderConfig(config)).toEqual(config);
    expect(DEFAULT_DAILY_CALL_LIMIT).toBe(24);
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(2048);
  });

  it("preserves an optional explicit reasoning effort", () => {
    expect(parseProviderConfig({ ...config, api: { ...api, reasoningEffort: "high" } }).api?.reasoningEffort).toBe("high");
  });

  it.each([
    ["unknown provider field", { ...config, unexpected: true }],
    ["unknown API field", { ...config, api: { ...api, unexpected: true } }],
    ["missing model", { ...config, api: { ...api, model: undefined } }],
    ["HTTP endpoint", { ...config, api: { ...api, baseUrl: "http://example.test/v1" } }],
    ["endpoint credentials", { ...config, api: { ...api, baseUrl: "https://user:pass@example.test/v1" } }],
    ["endpoint query", { ...config, api: { ...api, baseUrl: "https://example.test/v1?token=synthetic" } }],
    ["endpoint fragment", { ...config, api: { ...api, baseUrl: "https://example.test/v1#fragment" } }],
    ["zero output limit", { ...config, api: { ...api, maxOutputTokens: 0 } }],
    ["negative daily limit", { ...config, api: { ...api, dailyCallLimit: -1 } }],
    ["unknown reasoning effort", { ...config, api: { ...api, reasoningEffort: "x" } }],
    ["whitespace-only name", { ...config, api: { ...api, name: "   " } }],
    ["whitespace-only model", { ...config, api: { ...api, model: "\t\n" } }],
    ["whitespace-only key reference", { ...config, api: { ...api, keyRef: "  " } }],
    ["control character in model", { ...config, api: { ...api, model: "synthetic\nmodel" } }],
    ["control character in profile", { ...config, api: { ...api, profileId: "api-\u0000-1" } }],
    ["oversized provider name", { ...config, api: { ...api, name: "x".repeat(257) } }],
    ["oversized model", { ...config, api: { ...api, model: "x".repeat(257) } }],
  ])("rejects %s", (_name, value) => {
    expect(() => parseProviderConfig(value)).toThrow("OBSERVER_PROVIDER_CONFIG_INVALID");
  });

  it("projects a renderer-safe DTO without keyRef", () => {
    const publicConfig = toPublicProviderConfig(config);
    expect(publicConfig).toEqual({
      version: 1,
      selected: "api",
      api: {
        profileId: "api-1",
        name: "Synthetic test provider",
        baseUrl: "https://example.test/v1",
        protocol: "responses",
        model: "synthetic-model",
        maxOutputTokens: 2048,
        dailyCallLimit: 24,
        keyConfigured: false,
      },
    });
    expect(JSON.stringify(publicConfig)).not.toContain("keyRef");
    expect(JSON.stringify(publicConfig)).not.toContain("opaque-ref-1");
    expect(toPublicProviderConfig(config, true).api?.keyConfigured).toBe(true);
  });

  it("freezes the nested API configuration after parsing", () => {
    const parsed = parseProviderConfig(config);
    expect(Object.isFrozen(parsed.api)).toBe(true);
    expect(() => {
      if (parsed.api !== null) parsed.api.model = "mutated-model";
    }).toThrow(TypeError);
    expect(parsed.api?.model).toBe("synthetic-model");
  });

  it("reads absent configuration as a legacy fallback and persists bounded JSON atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "observer-provider-config-"));
    const path = join(directory, "provider.json");
    try {
      expect(await readProviderConfig(path)).toBeNull();
      await saveProviderConfig(path, config);
      expect(await readProviderConfig(path)).toEqual(config);
      await writeFile(path, "x".repeat(16 * 1024 + 1));
      await expect(readProviderConfig(path)).rejects.toThrow("OBSERVER_PROVIDER_CONFIG_INVALID");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves the existing config when validation or serialization fails before replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "observer-provider-config-preserve-"));
    const path = join(directory, "provider.json");
    try {
      await saveProviderConfig(path, config);
      await expect(saveProviderConfig(path, { ...config, api: { ...api, model: "" } })).rejects.toThrow();
      expect(await readProviderConfig(path)).toEqual(config);
      expect(await readFile(path, "utf8")).not.toContain("synthetic-model\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("sanitizes filesystem failures without exposing the config path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "observer-provider-config-error-"));
    const blocker = join(directory, "blocked-parent");
    const path = join(blocker, "provider.json");
    try {
      await writeFile(blocker, "not-a-directory");
      await expect(saveProviderConfig(path, config)).rejects.toThrow("OBSERVER_PROVIDER_CONFIG_STORAGE_UNAVAILABLE");
      await expect(saveProviderConfig(path, config)).rejects.not.toThrow(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
