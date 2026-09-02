import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionHttpClient, HudClientError } from "../../src/mcp/report-client.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ baseUrl: string; tokenPath: string; close(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "hud-client-"));
  const tokenPath = join(directory, "auth.token");
  await writeFile(tokenPath, "test-token\n");
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fixture address");
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
    await rm(directory, { recursive: true, force: true });
  };
  cleanups.push(close);
  return { baseUrl: `http://127.0.0.1:${address.port}`, tokenPath, close };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const health = {
  service: "codex-progress-hud" as const,
  pid: 4312,
  version: "0.2.0",
  protocolVersion: 1 as const,
  instanceNonce: "fixture-nonce",
  startedAt: "2026-09-01T01:02:03.000Z",
  visibility: "visible" as const
};

describe("CompanionHttpClient", () => {
  it("reads only minimal identity without sending the bearer token", async () => {
    let authorization: string | undefined;
    let deadline: string | string[] | undefined;
    const { baseUrl, tokenPath } = await fixture((request, response) => {
      authorization = request.headers.authorization;
      deadline = request.headers["x-codex-progress-hud-deadline-ms"];
      json(response, 200, { service: "codex-progress-hud", protocolVersion: 1 });
    });

    const result = await new CompanionHttpClient(baseUrl, tokenPath).identity();

    expect(result).toEqual({ service: "codex-progress-hud", protocolVersion: 1 });
    expect(authorization).toBeUndefined();
    expect(deadline).toBeUndefined();
  });

  it("authenticates full health and validates its complete shape", async () => {
    let authorization: string | undefined;
    let deadline: string | string[] | undefined;
    const { baseUrl, tokenPath } = await fixture((request, response) => {
      authorization = request.headers.authorization;
      deadline = request.headers["x-codex-progress-hud-deadline-ms"];
      json(response, 200, health);
    });
    const earliestDeadline = Date.now() + 400;

    expect(await new CompanionHttpClient(baseUrl, tokenPath).health({ timeoutMs: 500 })).toEqual(health);
    expect(authorization).toBe("Bearer test-token");
    expect(deadline).toMatch(/^\d+$/u);
    expect(Number(deadline)).toBeGreaterThanOrEqual(earliestDeadline);
    expect(Number.isSafeInteger(Number(deadline))).toBe(true);
  });

  it("uses authenticated JSON controls and preserves task requests", async () => {
    const seen: Array<{
      method: string | undefined;
      path: string | undefined;
      authorization: string | undefined;
      body: string;
    }> = [];
    const { baseUrl, tokenPath } = await fixture((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        seen.push({
          method: request.method,
          path: request.url,
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8")
        });
        if (request.url === "/api/health") json(response, 200, health);
        else if (request.url === "/api/snapshot") json(response, 200, { task: null, eta: null });
        else if (request.url === "/api/events") json(response, 202, { task: null, eta: null });
        else json(response, 202, { accepted: true });
      });
    });
    const client = new CompanionHttpClient(baseUrl, tokenPath);

    await client.show();
    await client.hide();
    await client.shutdown();
    await client.status();
    await client.submit({ taskId: "task-1", title: "Test", event: { type: "turn_started" } });

    expect(seen.map(({ method, path }) => [method, path])).toEqual([
      ["POST", "/api/window/show"],
      ["POST", "/api/window/hide"],
      ["POST", "/api/shutdown"],
      ["GET", "/api/snapshot"],
      ["POST", "/api/events"]
    ]);
    expect(seen.every(({ authorization }) => authorization === "Bearer test-token")).toBe(true);
    expect(seen.slice(0, 3).map(({ body }) => body)).toEqual(["{}", "{}", "{}"]);
    expect(JSON.parse(seen[4]!.body)).toEqual({
      taskId: "task-1",
      title: "Test",
      event: { type: "turn_started" }
    });
  });

  it("categorizes network refusal separately from authentication failure", async () => {
    const offlineFixture = await fixture((_request, response) => json(response, 200, {}));
    await offlineFixture.close();
    cleanups.pop();
    const authFixture = await fixture((_request, response) =>
      json(response, 401, { error: "secret raw response" })
    );

    await expect(
      new CompanionHttpClient(offlineFixture.baseUrl, offlineFixture.tokenPath).identity()
    ).rejects.toMatchObject({ code: "OFFLINE" });
    await expect(
      new CompanionHttpClient(authFixture.baseUrl, authFixture.tokenPath).health()
    ).rejects.toMatchObject({ code: "AUTH_ERROR" });
  });

  it("does not expose raw response bodies or tokens in typed errors", async () => {
    const secretBody = "server-secret-body";
    const { baseUrl, tokenPath } = await fixture((_request, response) =>
      json(response, 500, { error: secretBody, token: "test-token" })
    );

    const error = await new CompanionHttpClient(baseUrl, tokenPath).health().catch((caught) => caught);

    expect(error).toBeInstanceOf(HudClientError);
    expect(String(error)).not.toContain(secretBody);
    expect(String(error)).not.toContain("test-token");
  });

  it("rejects foreign services and incompatible protocol versions with distinct codes", async () => {
    let incompatible = false;
    const { baseUrl, tokenPath } = await fixture((_request, response) => {
      json(
        response,
        200,
        incompatible
          ? { service: "codex-progress-hud", protocolVersion: 2 }
          : { service: "other-service", protocolVersion: 1 }
      );
    });
    const client = new CompanionHttpClient(baseUrl, tokenPath);

    await expect(client.identity()).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    incompatible = true;
    await expect(client.identity()).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
  });

  it.each([
    ["404", 404, "application/json", JSON.stringify({ error: "missing-secret" })],
    ["500", 500, "application/json", JSON.stringify({ error: "server-secret" })],
    ["HTML", 200, "text/html", "<html>private foreign page</html>"],
    ["empty", 200, "application/json", ""],
    ["malformed JSON", 200, "application/json", "{private-malformed"]
  ])("classifies an established non-identity %s response as a port conflict", async (
    _name,
    status,
    contentType,
    body
  ) => {
    const { baseUrl, tokenPath } = await fixture((_request, response) => {
      response.writeHead(status, { "content-type": contentType });
      response.end(body);
    });

    const error = await new CompanionHttpClient(baseUrl, tokenPath).identity().catch((caught) => caught);

    expect(error).toMatchObject({ code: "PORT_CONFLICT" });
    expect(String(error)).not.toContain("secret");
    expect(String(error)).not.toContain("private");
  });

  it("categorizes its own deadline abort separately from an offline connection", async () => {
    const { baseUrl, tokenPath } = await fixture(() => undefined);
    const controller = new AbortController();
    const startedAt = performance.now();
    const externalAbort = setTimeout(() => controller.abort(), 250);

    const error = await new CompanionHttpClient(baseUrl, tokenPath)
      .identity({ timeoutMs: 75, signal: controller.signal })
      .catch((caught) => caught);
    clearTimeout(externalAbort);

    expect(error).toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it("categorizes a server-enforced request deadline as a request timeout", async () => {
    const { baseUrl, tokenPath } = await fixture((_request, response) =>
      json(response, 408, { error: "request deadline expired" })
    );

    await expect(new CompanionHttpClient(baseUrl, tokenPath).health({ timeoutMs: 500 }))
      .rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
  });

  it("gives a pre-aborted external signal precedence over a zero client budget", async () => {
    const { baseUrl, tokenPath } = await fixture(() => undefined);
    const controller = new AbortController();
    controller.abort();

    const error = await new CompanionHttpClient(baseUrl, tokenPath)
      .identity({ timeoutMs: 0, signal: controller.signal })
      .catch((caught) => caught);

    expect(error).toMatchObject({ code: "REQUEST_CANCELLED" });
  });

  it("categorizes external cancellation separately from its own deadline and offline", async () => {
    const { baseUrl, tokenPath } = await fixture(() => undefined);
    const controller = new AbortController();
    const startedAt = performance.now();
    const request = new CompanionHttpClient(baseUrl, tokenPath).identity({
      timeoutMs: 500,
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 20);

    const error = await request.catch((caught) => caught);

    expect(error).toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(performance.now() - startedAt).toBeLessThan(300);
  });

  it("bounds an authenticated token read that never settles with the request deadline", async () => {
    const { baseUrl, tokenPath } = await fixture((_request, response) => json(response, 200, health));
    let tokenSignal: AbortSignal | undefined;
    const readToken = vi.fn((_path: string, options: { signal: AbortSignal }) => {
      tokenSignal = options.signal;
      return new Promise<string>(() => undefined);
    });
    const client = new CompanionHttpClient(baseUrl, tokenPath, readToken);
    const startedAt = performance.now();

    const error = await Promise.race([
      client.health({ timeoutMs: 90 }).catch((caught) => caught),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("token read exceeded the request deadline")), 300)
      )
    ]);

    expect(error).toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(performance.now() - startedAt).toBeLessThan(300);
    expect(tokenSignal?.aborted).toBe(true);
  });

  it.each([
    ["deadline", 90, undefined, "REQUEST_TIMEOUT"],
    ["external cancellation", 500, 20, "REQUEST_CANCELLED"]
  ] as const)("keeps %s as first cause when token loading fails late", async (
    _name,
    timeoutMs,
    externalAbortMs,
    code
  ) => {
    const { baseUrl, tokenPath } = await fixture((_request, response) => json(response, 200, health));
    let rejectToken!: (error: Error) => void;
    const tokenRead = new Promise<string>((_resolve, reject) => { rejectToken = reject; });
    void tokenRead.catch(() => undefined);
    const controller = new AbortController();
    const client = new CompanionHttpClient(baseUrl, tokenPath, () => tokenRead);
    const startedAt = performance.now();
    const request = client.health({ timeoutMs, signal: controller.signal });
    if (externalAbortMs !== undefined) setTimeout(() => controller.abort(), externalAbortMs);

    const error = await Promise.race([
      request.catch((caught) => caught),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("token read exceeded the first-cause budget")), 300)
      )
    ]);
    rejectToken(new Error("late private token failure"));
    await Promise.resolve();

    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("private token");
    expect(performance.now() - startedAt).toBeLessThan(300);
  });

  it("bounds streamed JSON responses without exposing their content", async () => {
    const secret = "oversized-private-content";
    const { baseUrl, tokenPath } = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write(`{"service":"codex-progress-hud","protocolVersion":1,"padding":"${secret}`);
      response.write("x".repeat(70_000));
    });

    const error = await new CompanionHttpClient(baseUrl, tokenPath)
      .identity({ timeoutMs: 500 })
      .catch((caught) => caught);

    expect(error).toMatchObject({ code: "PORT_CONFLICT" });
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("padding");
  });
});
