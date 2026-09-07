import { describe, expect, it } from "vitest";
import { createOpenAIProvider } from "../../src/estimation/openai-provider.js";

const metrics = { activeSeconds: 10, progress: 0.5, toolCount: 3, validationFailures: 0 };
const signal = () => new AbortController().signal;
const response = (text = '{"lowSeconds":10,"highSeconds":20}') => new Response(JSON.stringify({
  status: "completed", output: [{ type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 1000, output_tokens: 100, output_tokens_details: { reasoning_tokens: 80 } }
}));
function setup(options: { consent?: boolean; allowed?: boolean; body?: () => Response } = {}) {
  const requests: { url: string; init: RequestInit }[] = []; const charges: number[] = [];
  const provider = createOpenAIProvider({
    apiKey: "test-only-placeholder", metricsConsent: options.consent ?? true,
    reserveSpend: async amount => { charges.push(amount); return options.allowed ?? true; },
    transport: async (url, init) => { requests.push({ url, init }); return options.body?.() ?? response(); }
  });
  return { provider, requests, charges };
}

describe("OpenAI estimator boundary (no network)", () => {
  it("sends only fixed structured configuration and numerical metrics after spend reservation", async () => {
    const h = setup(); const result = await h.provider.estimate(metrics, signal());
    expect(result).toEqual({ prediction: { lowSeconds: 10, highSeconds: 20 }, costMicrousd: 370 });
    const request = h.requests[0]!; const body = JSON.parse(request.init.body as string);
    expect(request.url).toBe("https://api.openai.com/v1/responses");
    expect(request.init.redirect).toBe("error");
    expect(body).toMatchObject({ model: "gpt-5.6-luna", reasoning: { effort: "medium" }, store: false,
      max_output_tokens: 2048, service_tier: "default", text: { format: { type: "json_schema", strict: true } } });
    expect(body.tools).toBeUndefined(); expect(JSON.parse(body.input)).toEqual(metrics);
    expect(h.charges).toEqual([h.provider.reservationMicrousd]);
  });
  it("blocks without data consent before reserving or using transport", async () => {
    const h = setup({ consent: false });
    await expect(h.provider.estimate(metrics, signal())).rejects.toThrow("CONSENT_REQUIRED");
    expect(h.charges).toHaveLength(0); expect(h.requests).toHaveLength(0);
  });
  it("blocks insufficient budget and aborted work before transport", async () => {
    const h = setup({ allowed: false });
    await expect(h.provider.estimate(metrics, signal())).rejects.toThrow("BUDGET_EXHAUSTED");
    expect(h.requests).toHaveLength(0);
    const controller = new AbortController(); controller.abort();
    await expect(h.provider.estimate(metrics, controller.signal)).rejects.toThrow();
    expect(h.charges).toHaveLength(1);
  });
  it.each([
    () => response('{"lowSeconds":20,"highSeconds":10}'),
    () => new Response(JSON.stringify({ status: "incomplete", output: [] })),
    () => new Response("denied", { status: 401 }),
    () => new Response("x".repeat(65_537)),
    () => response('{"lowSeconds":1,"highSeconds":2,"task_handle":"bad"}')
  ])("rejects invalid output without retries or leaking response bodies", async body => {
    const h = setup({ body });
    await expect(h.provider.estimate(metrics, signal())).rejects.toThrow(/^ESTIMATOR_/);
    expect(h.requests).toHaveLength(1); expect(h.charges).toHaveLength(1);
  });
  it("accepts an explicit unknown prediction, not a fabricated zero ETA", async () => {
    const h = setup({ body: () => response('{"lowSeconds":null,"highSeconds":null}') });
    expect(await h.provider.estimate(metrics, signal())).toMatchObject({ prediction: null });
  });
  it("rejects additional input fields before any spend or network", async () => {
    const h = setup();
    await expect(h.provider.estimate({ ...metrics, prompt: "private" } as typeof metrics, signal())).rejects.toThrow();
    expect(h.charges).toHaveLength(0); expect(h.requests).toHaveLength(0);
  });
});
