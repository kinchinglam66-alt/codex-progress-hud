import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgressServer } from "../dist/server/http-server.js";
import { PROTOCOL_VERSION } from "../dist/lifecycle/types.js";

const dataDirectory = await mkdtemp(join(tmpdir(), "codex-progress-hud-smoke-"));
const tokenPath = join(dataDirectory, "auth.token");
let shutdownRequested = false;
const health = {
  service: "codex-progress-hud",
  pid: process.pid,
  version: "0.2.0-smoke",
  protocolVersion: PROTOCOL_VERSION,
  instanceNonce: "smoke-owned-instance",
  startedAt: new Date().toISOString(),
  visibility: "visible"
};
const server = createProgressServer({
  port: 0,
  tokenPath,
  health: () => health,
  requestShutdown: () => {
    shutdownRequested = true;
  }
});

try {
  await server.listen();
  const token = (await readFile(tokenPath, "utf8")).trim();
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-codex-progress-hud-protocol": String(PROTOCOL_VERSION)
  };
  const identityResponse = await fetch(`${server.address().url}/health`);
  const identity = await identityResponse.json();
  const healthResponse = await fetch(`${server.address().url}/api/health`, { headers });
  const authenticatedHealth = await healthResponse.json();
  const eventResponse = await fetch(`${server.address().url}/api/events`, {
    method: "POST",
    headers: { ...headers, "x-codex-progress-hud-revision": "0" },
    body: JSON.stringify({
      taskId: "hud_smoke_task_abcdefghijklmnopqrstuvwxyz",
      title: "Synthetic verification",
      event: {
        type: "tracking_started"
      }
    })
  });
  const snapshotResponse = await fetch(`${server.address().url}/api/snapshot`, { headers });
  const snapshot = await snapshotResponse.json();
  const shutdownResponse = await fetch(`${server.address().url}/api/shutdown`, {
    method: "POST",
    headers,
    body: "{}"
  });
  const shutdown = await shutdownResponse.json();
  if (
    identityResponse.status !== 200 ||
    identity.service !== "codex-progress-hud" ||
    identity.protocolVersion !== PROTOCOL_VERSION ||
    healthResponse.status !== 200 ||
    authenticatedHealth.protocolVersion !== PROTOCOL_VERSION ||
    authenticatedHealth.instanceNonce !== health.instanceNonce ||
    eventResponse.status !== 202 ||
    snapshotResponse.status !== 200 ||
    snapshot.selected?.task?.status !== "running" ||
    snapshot.selected?.task?.progress !== undefined ||
    shutdownResponse.status !== 202 ||
    shutdown.accepted !== true ||
    !shutdownRequested
  ) {
    throw new Error("smoke verification returned an unexpected lifecycle result");
  }
  process.stdout.write(
    "Smoke test passed: protocol health, authenticated event flow, and shutdown callback verified.\n"
  );
} finally {
  await server.close();
  await rm(dataDirectory, { recursive: true, force: true });
}
