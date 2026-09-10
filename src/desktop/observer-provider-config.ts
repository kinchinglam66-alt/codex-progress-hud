import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";

export const DEFAULT_DAILY_CALL_LIMIT = 24;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

const MAX_CONFIG_BYTES = 16 * 1024;
const controlFreeText = (max: number) => z.string().min(1).max(max).refine(
  (value) => !/[\p{Cc}\p{Cf}]/u.test(value),
).refine((value) => value.trim().length > 0);

const apiSchema = z.object({
  profileId: controlFreeText(128),
  name: controlFreeText(256),
  baseUrl: controlFreeText(2048).refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  }),
  protocol: z.literal("responses"),
  model: controlFreeText(256),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  keyRef: controlFreeText(256),
  maxOutputTokens: z.number().int().positive().safe().max(1_000_000),
  dailyCallLimit: z.number().int().positive().safe().max(1_000_000),
}).strict();

const providerConfigSchema = z.object({
  version: z.literal(1),
  selected: z.enum(["subscription", "api"]),
  api: apiSchema.nullable(),
}).strict();

export type ApiConfig = z.infer<typeof apiSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type PublicApiConfig = Omit<ApiConfig, "keyRef"> & { keyConfigured: boolean };
export type PublicProviderConfig = {
  version: 1;
  selected: ProviderConfig["selected"];
  api: PublicApiConfig | null;
};

export function parseProviderConfig(value: unknown): ProviderConfig {
  const parsed = providerConfigSchema.safeParse(value);
  if (!parsed.success) throw new Error("OBSERVER_PROVIDER_CONFIG_INVALID");
  return Object.freeze({
    ...parsed.data,
    api: parsed.data.api === null ? null : Object.freeze({ ...parsed.data.api }),
  });
}

export function toPublicProviderConfig(value: ProviderConfig, keyConfigured = false): PublicProviderConfig {
  const config = parseProviderConfig(value);
  return Object.freeze({
    version: 1,
    selected: config.selected,
    api: config.api === null ? null : Object.freeze({
      profileId: config.api.profileId,
      name: config.api.name,
      baseUrl: config.api.baseUrl,
      protocol: config.api.protocol,
      model: config.api.model,
      ...(config.api.reasoningEffort === undefined ? {} : { reasoningEffort: config.api.reasoningEffort }),
      maxOutputTokens: config.api.maxOutputTokens,
      dailyCallLimit: config.api.dailyCallLimit,
      keyConfigured,
    }),
  });
}

export async function readProviderConfig(path: string): Promise<ProviderConfig | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("OBSERVER_PROVIDER_CONFIG_INVALID");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_CONFIG_BYTES) {
    throw new Error("OBSERVER_PROVIDER_CONFIG_INVALID");
  }

  const file = await open(path, "r").catch(() => {
    throw new Error("OBSERVER_PROVIDER_CONFIG_INVALID");
  });
  try {
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CONFIG_BYTES) throw new Error();
    return parseProviderConfig(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
  } catch {
    throw new Error("OBSERVER_PROVIDER_CONFIG_INVALID");
  } finally {
    await file.close().catch(() => undefined);
  }
}

export async function saveProviderConfig(path: string, value: unknown): Promise<void> {
  const config = parseProviderConfig(value);
  const serialized = `${JSON.stringify(config)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("OBSERVER_PROVIDER_CONFIG_INVALID");
  }
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch {
    throw new Error("OBSERVER_PROVIDER_CONFIG_STORAGE_UNAVAILABLE");
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
