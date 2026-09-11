import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RELEASE_CAPABILITIES } from "../../src/generated/capabilities.js";
import { CompanionHttpClient, HudClientError } from "../../src/mcp/report-client.js";
import {TaskStore} from '../../src/server/task-store.js';

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
  protocolVersion: 3 as const,
  instanceNonce: "fixture-nonce",
  startedAt: "2026-09-01T01:02:03.000Z",
  visibility: "visible" as const
};

describe("CompanionHttpClient", () => {
  it.each([true,false,'true',null])('validates typed timing and runtime uncertainty diagnostics (%s)',async(value)=>{
    const store=new TaskStore({now:()=>100});
    store.apply({taskId:'test',event:{type:'tracking_started'}});
    const snapshot=store.snapshot();
    const goal={generation:0,estimateRevision:0,sampledAtMs:100,status:'unknown',runtime:'running',activeSeconds:0,prediction:null,timingUncertain:value,runtimeUncertain:value};
    const row={conversationKey:'conversation',task:snapshot.selected!.task,eta:null,name:{value:null,freshness:'unavailable'},goal};
    const {baseUrl,tokenPath}=await fixture((_request,response)=>json(response,200,{...snapshot,rows:[row]}));
    const result=new CompanionHttpClient(baseUrl,tokenPath).status();
    if(typeof value==='boolean')await expect(result).resolves.toMatchObject({rows:[{goal}]});
    else await expect(result).rejects.toBeInstanceOf(HudClientError);
  });
  it('accepts a bounded local admission diagnostic in the real snapshot response',async()=>{
    const store=new TaskStore();
    store.apply({taskId:'task',event:{type:'turn_started'}},0,
      {conversationKey:'chat',turnKey:'turn',isCurrentTurn:true});
    const snapshot=store.snapshot(0);
    snapshot.rows![0]!.observer={state:'admission_blocked',admissionReason:'unresolved_previous_call',
      estimateAgeSeconds:null,callsLastHour:1,retryPending:false};
    const {baseUrl,tokenPath}=await fixture((_request,response)=>json(response,200,snapshot));
    const client=new CompanionHttpClient(baseUrl,tokenPath);
    await expect(client.status()).resolves.toMatchObject({rows:[{observer:{
      state:'admission_blocked',admissionReason:'unresolved_previous_call',
    }}]});
  });
  const aggregateSnapshot = {
    revision: 3,
    selectedTaskId: "hud_abcdefghijklmnopqrstuvwxyz0123456789",
    selectionMode: "pinned" as const,
    tasks: [{
      id: "hud_abcdefghijklmnopqrstuvwxyz0123456789",
      title: "Codex task",
      status: "running" as const,
      lastActivityAt: 100,
      hiddenForTask: false
    }],
    selected: null,
    compatibility: { incompatibleClientSeen: false }
  };

  it("parses aggregate snapshots and sends explicit revisioned per-task calls", async () => {
    const seen: Array<{ method: string | undefined; path: string | undefined; body: string; revision: string | undefined }> = [];
    const { baseUrl, tokenPath } = await fixture((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        seen.push({
          method: request.method,
          path: request.url,
          body: Buffer.concat(chunks).toString("utf8"),
          revision: request.headers["x-codex-progress-hud-revision"] as string | undefined
        });
        json(response, 202, aggregateSnapshot);
      });
    });
    const client = new CompanionHttpClient(baseUrl, tokenPath);
    const options = { revision: 3, generation: 7 };

    await expect(client.status()).resolves.toEqual(aggregateSnapshot);
    await expect(client.selectTask(aggregateSnapshot.selectedTaskId, "pinned", options)).resolves.toEqual(aggregateSnapshot);
    await expect(client.setTaskVisibility(aggregateSnapshot.selectedTaskId, true, options)).resolves.toEqual(aggregateSnapshot);
    await expect(client.submitHook({
      schemaVersion: 2,
      taskHandle: aggregateSnapshot.selectedTaskId,
      eventId: "evt_abcdefghijklmnopqrstuvwxyz0123456789",
      sessionKey: "session_abcdefghijklmnopqrstuvwxyz0123456789",
      hook: "Stop",
      receivedAt: 100
    }, options)).resolves.toEqual(aggregateSnapshot);

    expect(seen.map(({ method, path }) => [method, path])).toEqual([
      ["GET", "/api/snapshot"],
      ["POST", `/api/tasks/${encodeURIComponent(aggregateSnapshot.selectedTaskId)}/select`],
      ["POST", `/api/tasks/${encodeURIComponent(aggregateSnapshot.selectedTaskId)}/visibility`],
      ["POST", "/api/hooks/events"]
    ]);
    expect(seen.slice(1).map(({ revision }) => revision)).toEqual(["3", "3", "3"]);
    expect(JSON.parse(seen[1]!.body)).toEqual({ mode: "pinned" });
    expect(JSON.parse(seen[2]!.body)).toEqual({ hidden: true });
  });

  it.each([
    { conversationKey: "" },
    { turnKey: "x".repeat(161) },
    { isCurrentTurn: "true" },
    { conversationKey: 42 }
  ])("rejects malformed turn summary metadata %j", async (metadata) => {
    const { baseUrl, tokenPath } = await fixture((_request, response) => json(response, 200, {
      ...aggregateSnapshot, tasks: [{ ...aggregateSnapshot.tasks[0], ...metadata }]
    }));
    await expect(new CompanionHttpClient(baseUrl, tokenPath).status()).rejects.toBeInstanceOf(HudClientError);
  });

  it("rejects incomplete or unknown tracking diagnostic fields", async () => {
    const { baseUrl, tokenPath } = await fixture((_request, response) => json(response, 200, {
      ...aggregateSnapshot, turnTracking: { identityUnavailable: true, arbitrary: true }
    }));
    await expect(new CompanionHttpClient(baseUrl, tokenPath).status()).rejects.toBeInstanceOf(HudClientError);
  });

  it("reacquires after a companion restart rejects the old lease", async () => {
    let eventAttempts = 0;
    let leaseAcquires = 0;
    const { baseUrl, tokenPath } = await fixture((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        if (request.url === "/api/leases/acquire") {
          leaseAcquires += 1;
          json(response, 200, { id: `lease_new_${leaseAcquires}`, ownerNonce: "owner", expiresAt: 60_000 });
          return;
        }
        if (request.url === "/api/events" && eventAttempts++ === 0) {
          json(response, 401, { code: "LEASE_REQUIRED" });
          return;
        }
        json(response, 202, aggregateSnapshot);
      });
    });
    const client = new CompanionHttpClient(baseUrl, tokenPath);
    client.setLeaseOwnerNonce("owner");
    client.setLease({ id: "lease_old", ownerNonce: "owner", expiresAt: 1 });

    await expect(client.submit({
      taskId: aggregateSnapshot.selectedTaskId,
      event: { type: "activity_resumed" }
    })).resolves.toEqual(aggregateSnapshot);
    expect(leaseAcquires).toBe(1);
    expect(eventAttempts).toBe(2);
  });

  it("reuses one absolute deadline across a recoverable lease retry", async () => {
    let now = 1_000;
    const eventHeaders: Array<{
      deadline: string;
      generation: string | undefined;
      revision: string | undefined;
    }> = [];
    let eventAttempts = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { baseUrl, tokenPath } = await fixture((request, response) => {
        request.resume();
        request.on("end", () => {
          if (request.url === "/api/leases/acquire") {
            json(response, 200, { id: "lease_new", ownerNonce: "owner", expiresAt: 60_000 });
            return;
          }
          if (request.url === "/api/events") {
            eventHeaders.push({
              deadline: String(request.headers["x-codex-progress-hud-deadline-ms"]),
              generation: request.headers["x-codex-progress-hud-generation"] as string | undefined,
              revision: request.headers["x-codex-progress-hud-revision"] as string | undefined
            });
            eventAttempts += 1;
            if (eventAttempts === 1) {
              now = 1_050;
              json(response, 401, { code: "LEASE_REQUIRED" });
              return;
            }
          }
          json(response, 202, aggregateSnapshot);
        });
      });
      const client = new CompanionHttpClient(baseUrl, tokenPath);
      client.setLeaseOwnerNonce("owner");
      client.setLease({ id: "lease_old", ownerNonce: "owner", expiresAt: 1 });

      await expect(client.submit({
        taskId: aggregateSnapshot.selectedTaskId,
        event: { type: "activity_resumed" }
      }, { timeoutMs: 100, generation: 7, revision: 3 })).resolves.toEqual(aggregateSnapshot);

      expect(eventHeaders).toEqual([
        { deadline: "1100", generation: "7", revision: "3" },
        { deadline: "1100", generation: "7", revision: "3" }
      ]);
      expect(Number(eventHeaders[1]?.deadline)).toBe(1_100);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("does not extend a lease retry past its original absolute deadline", async () => {
    let now = 1_000;
    let eventAttempts = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { baseUrl, tokenPath } = await fixture((request, response) => {
        request.resume();
        request.on("end", () => {
          if (request.url === "/api/leases/acquire") {
            json(response, 200, { id: "lease_new", ownerNonce: "owner", expiresAt: 60_000 });
            return;
          }
          if (request.url === "/api/events") {
            eventAttempts += 1;
            if (eventAttempts === 1) {
              now = 1_101;
              json(response, 401, { code: "LEASE_REQUIRED" });
              return;
            }
          }
          json(response, 202, aggregateSnapshot);
        });
      });
      const client = new CompanionHttpClient(baseUrl, tokenPath);
      client.setLeaseOwnerNonce("owner");
      client.setLease({ id: "lease_old", ownerNonce: "owner", expiresAt: 1 });

      await expect(client.submit({
        taskId: aggregateSnapshot.selectedTaskId,
        event: { type: "activity_resumed" }
      }, { timeoutMs: 100 })).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
      expect(eventAttempts).toBe(1);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("keeps status observational and starts the lease only for the first mutation", async () => {
    const seen: string[] = [];
    const lease = { id: "lease_lazy", ownerNonce: "owner", expiresAt: 60_000 };
    const { baseUrl, tokenPath } = await fixture((request, response) => {
      seen.push(request.url ?? "");
      json(response, request.url === "/api/events" ? 202 : 200, aggregateSnapshot);
    });
    const client = new CompanionHttpClient(baseUrl, tokenPath);
    client.setLeaseOwnerNonce("owner");
    const start = vi.fn(async () => lease);
    const invalidate = vi.fn();
    client.setLeaseCoordinator({ start, invalidate });

    await client.status();
    expect(start).not.toHaveBeenCalled();
    await client.submit({
      taskId: aggregateSnapshot.selectedTaskId,
      event: { type: "activity_resumed" }
    });

    expect(start).toHaveBeenCalledOnce();
    expect(seen).toEqual(["/api/snapshot", "/api/events"]);
  });

  it("single-flights concurrent initial lease acquisition", async () => {
    let releaseAcquire!: () => void;
    const acquireGate = new Promise<void>((resolve) => { releaseAcquire = resolve; });
    let leaseAcquires = 0;
    const { baseUrl, tokenPath } = await fixture((request, response) => {
      request.resume();
      request.on("end", () => {
        if (request.url === "/api/leases/acquire") {
          leaseAcquires += 1;
          void acquireGate.then(() => json(response, 200, {
            id: "lease_shared", ownerNonce: "owner", expiresAt: 60_000
          }));
          return;
        }
        json(response, 202, aggregateSnapshot);
      });
    });
    const client = new CompanionHttpClient(baseUrl, tokenPath);
    client.setLeaseOwnerNonce("owner");

    const submissions = [
      client.submit({ taskId: aggregateSnapshot.selectedTaskId, event: { type: "activity_resumed" } }),
      client.submit({ taskId: aggregateSnapshot.selectedTaskId, event: { type: "activity_resumed" } })
    ];
    await vi.waitFor(() => expect(leaseAcquires).toBeGreaterThanOrEqual(1));
    await new Promise((resolve) => setImmediate(resolve));
    releaseAcquire();

    await expect(Promise.all(submissions)).resolves.toHaveLength(2);
    expect(leaseAcquires).toBe(1);
  });

  it("single-flights concurrent reacquisition and never lets a stale rejection clear the replacement", async () => {
    const pendingOldResponses: ServerResponse[] = [];
    let leaseAcquires = 0;
    let replacementEvents = 0;
    const { baseUrl, tokenPath } = await fixture((request, response) => {
      request.resume();
      request.on("end", () => {
        if (request.url === "/api/leases/acquire") {
          leaseAcquires += 1;
          json(response, 200, { id: "lease_new", ownerNonce: "owner", expiresAt: 60_000 });
          return;
        }
        if (request.url === "/api/events" && request.headers["x-codex-progress-hud-lease"] === "lease_old") {
          pendingOldResponses.push(response);
          if (pendingOldResponses.length === 2) {
            for (const oldResponse of pendingOldResponses) {
              json(oldResponse, 401, { code: "LEASE_REQUIRED" });
            }
          }
          return;
        }
        replacementEvents += 1;
        json(response, 202, aggregateSnapshot);
      });
    });
    const client = new CompanionHttpClient(baseUrl, tokenPath);
    client.setLeaseOwnerNonce("owner");
    client.setLease({ id: "lease_old", ownerNonce: "owner", expiresAt: 1 });

    await expect(Promise.all([
      client.submit({ taskId: aggregateSnapshot.selectedTaskId, event: { type: "activity_resumed" } }),
      client.submit({ taskId: aggregateSnapshot.selectedTaskId, event: { type: "activity_resumed" } })
    ])).resolves.toHaveLength(2);

    expect(leaseAcquires).toBe(1);
    expect(replacementEvents).toBe(2);
  });

  it("does not reacquire or retry a rejected explicit lease option", async () => {
    let leaseAcquires = 0;
    let eventAttempts = 0;
    const { baseUrl, tokenPath } = await fixture((request, response) => {
      request.resume();
      request.on("end", () => {
        if (request.url === "/api/leases/acquire") {
          leaseAcquires += 1;
          json(response, 200, { id: "lease_new", ownerNonce: "owner", expiresAt: 60_000 });
          return;
        }
        eventAttempts += 1;
        json(response, 403, { code: "LEASE_FORBIDDEN" });
      });
    });
    const client = new CompanionHttpClient(baseUrl, tokenPath);
    client.setLeaseOwnerNonce("owner");
    client.setLease({ id: "lease_internal", ownerNonce: "owner", expiresAt: 60_000 });

    await expect(client.submit({
      taskId: aggregateSnapshot.selectedTaskId,
      event: { type: "activity_resumed" }
    }, { leaseId: "lease_explicit_stale", ownerNonce: "owner" })).rejects.toMatchObject({
      code: "LEASE_FORBIDDEN"
    });
    expect(eventAttempts).toBe(1);
    expect(leaseAcquires).toBe(0);
  });

  it("accepts the optional authenticated capabilities on aggregate snapshots", async () => {
    const { baseUrl, tokenPath } = await fixture((_request, response) =>
      json(response, 200, {
        ...aggregateSnapshot,
        capabilities: {
          service: "codex-progress-hud",
          companionVersion: "0.1.0",
          protocol: { current: 3, minimumClient: 3, maximumClient: 3 },
          incompatibleClientSeen: false
        }
      })
    );

    await expect(new CompanionHttpClient(baseUrl, tokenPath).status()).resolves.toMatchObject({
      revision: aggregateSnapshot.revision,
      selectedTaskId: aggregateSnapshot.selectedTaskId
    });
  });

  it("returns null for an unchanged revisioned snapshot and keeps ordinary status non-null", async () => {
    const { baseUrl, tokenPath } = await fixture((request, response) => {
      if (request.url === "/api/snapshot?afterRevision=3") {
        response.writeHead(204);
        response.end();
        return;
      }
      json(response, 200, aggregateSnapshot);
    });
    const client = new CompanionHttpClient(baseUrl, tokenPath);

    await expect(client.status({ afterRevision: 3 })).resolves.toBeNull();
    await expect(client.status()).resolves.toEqual(aggregateSnapshot);
  });

  it("reads only minimal identity without sending the bearer token", async () => {
    let authorization: string | undefined;
    let deadline: string | string[] | undefined;
    const { baseUrl, tokenPath } = await fixture((request, response) => {
      authorization = request.headers.authorization;
      deadline = request.headers["x-codex-progress-hud-deadline-ms"];
      json(response, 200, { service: "codex-progress-hud", protocolVersion: 3 });
    });

    const result = await new CompanionHttpClient(baseUrl, tokenPath).identity();

    expect(result).toEqual({ service: "codex-progress-hud", protocolVersion: 3 });
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

  it("opts into window diagnostics and retains only safe fields", async () => {
    const { baseUrl, tokenPath } = await fixture((request, response) => {
      if (request.headers["x-hud-window-diagnostics"] !== "1") return json(response, 200, health);
      json(response, 200, { ...health, windowDiagnostics: { exists: true, visible: true, page: "failed", renderer: "gone", domReady: false, readyToShow: true, secret: "private" } });
    });
    const result = await new CompanionHttpClient(baseUrl, tokenPath).health();
    expect(result).toMatchObject({ windowDiagnostics: { page: "failed", renderer: "gone" } });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("does not treat malformed optional diagnostics as a core protocol mismatch", async () => {
    const { baseUrl, tokenPath } = await fixture((_request, response) => json(response, 200, { ...health, windowDiagnostics: { page: "future-state" } }));
    expect(await new CompanionHttpClient(baseUrl, tokenPath).health()).toMatchObject(health);
  });

  it("uses authenticated JSON controls and preserves task requests", async () => {
    const seen: Array<{
      method: string | undefined;
      path: string | undefined;
      authorization: string | undefined;
      protocol: string | string[] | undefined;
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
          protocol: request.headers["x-codex-progress-hud-protocol"],
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
    expect(seen.slice(0, 3).map(({ protocol }) => protocol)).toEqual([
      String(RELEASE_CAPABILITIES.protocol.current),
      String(RELEASE_CAPABILITIES.protocol.current),
      String(RELEASE_CAPABILITIES.protocol.current)
    ]);
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
          ? { service: "codex-progress-hud", protocolVersion: 99 }
          : { service: "other-service", protocolVersion: 3 }
      );
    });
    const client = new CompanionHttpClient(baseUrl, tokenPath);

    await expect(client.identity()).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    incompatible = true;
    await expect(client.identity()).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
  });

  it("maps authenticated health with a range that excludes this client to VERSION_MISMATCH", async () => {
    const capabilities = {
      service: "codex-progress-hud" as const,
      companionVersion: "0.1.0",
      protocol: { current: 99, minimumClient: 99, maximumClient: 99 },
      incompatibleClientSeen: true
    };
    const { baseUrl, tokenPath } = await fixture((_request, response) =>
      json(response, 200, { ...health, capabilities })
    );

    await expect(new CompanionHttpClient(baseUrl, tokenPath).health()).rejects.toMatchObject({
      code: "VERSION_MISMATCH",
      message: "Progress HUD protocol is incompatible"
    });
  });

  it("maps an unknown authenticated HTTP failure to INTERNAL_ERROR", async () => {
    const { baseUrl, tokenPath } = await fixture((_request, response) =>
      json(response, 500, { error: "server failure" })
    );

    await expect(new CompanionHttpClient(baseUrl, tokenPath).submit({
      taskId: "task-1",
      title: "Server failure",
      event: { type: "turn_started" }
    })).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("preserves a structured protocol rejection code from an HTTP error body", async () => {
    const { baseUrl, tokenPath } = await fixture((_request, response) =>
      json(response, 409, {
        error: "client protocol is unsupported",
        code: "VERSION_MISMATCH"
      })
    );

    await expect(new CompanionHttpClient(baseUrl, tokenPath).submit({
      taskId: "task-1",
      title: "Protocol rejection",
      event: { type: "turn_started" }
    })).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
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

  it("categorizes shutdown-in-progress separately from generation rejection", async () => {
    const secretBody = "private-retirement-detail";
    const { baseUrl, tokenPath } = await fixture((_request, response) =>
      json(response, 423, { error: secretBody, code: "SHUTTING_DOWN" })
    );

    const error = await new CompanionHttpClient(baseUrl, tokenPath)
      .show({ generation: 2 })
      .catch((caught) => caught);

    expect(error).toMatchObject({ code: "SHUTTING_DOWN" });
    expect(String(error)).not.toContain(secretBody);
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
      response.write("x".repeat(600_000));
    });

    const error = await new CompanionHttpClient(baseUrl, tokenPath)
      .identity({ timeoutMs: 500 })
      .catch((caught) => caught);

    expect(error).toMatchObject({ code: "PORT_CONFLICT" });
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("padding");
  });
});
