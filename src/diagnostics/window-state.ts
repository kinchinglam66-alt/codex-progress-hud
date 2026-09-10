import { z } from "zod";

const dimension = z.number().int().min(0).max(65536);
export const windowDomSchema = z.object({
  hudPresent: z.boolean(), statusPresent: z.boolean(), closePresent: z.boolean(),
  stylesheetCount: z.number().int().min(0).max(1000),
  hudHidden: z.boolean(), hudHasBackground: z.boolean(), hudHasText: z.boolean(),
  viewportWidth: dimension, viewportHeight: dimension
});
export const windowContentSchema = z.object({
  status: z.enum(['pending', 'ready', 'timeout', 'failed']),
  dom: windowDomSchema.optional(),
  paint: z.object({
    width: dimension, height: dimension, sampledPixels: dimension,
    whitePixels: dimension, transparentPixels: dimension, varied: z.boolean()
  }).optional()
});
export type WindowContent = z.infer<typeof windowContentSchema>;

// Strict allowlist: never serialize URLs, console messages, DOM text or credentials.
export const windowDiagnosticsSchema = z.object({
  exists: z.boolean(),
  visible: z.boolean(),
  page: z.enum(["not-created", "loading", "dom-ready", "loaded", "failed"]),
  renderer: z.enum(["unknown", "responsive", "unresponsive", "gone"]),
  domReady: z.boolean(),
  readyToShow: z.boolean(),
  content: windowContentSchema.optional().catch(undefined),
  loadErrorCode: z.number().int().min(-2147483648).max(2147483647).optional(),
  rendererExitCode: z.number().int().min(-2147483648).max(2147483647).optional(),
  bounds: z.object({
    x: z.number().int(), y: z.number().int(),
    width: z.number().int().nonnegative(), height: z.number().int().nonnegative()
  }).optional()
});
export type WindowDiagnostics = z.infer<typeof windowDiagnosticsSchema>;

/** Optional instrumentation must never interrupt health, SSE or shutdown. */
export function readWindowDiagnostics(read: () => unknown): WindowDiagnostics | undefined {
  try {
    const result = windowDiagnosticsSchema.safeParse(read());
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
