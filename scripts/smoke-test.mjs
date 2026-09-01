import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgressServer } from "../dist/server/http-server.js";

const dataDirectory = await mkdtemp(join(tmpdir(), "codex-progress-hud-smoke-"));
const tokenPath = join(dataDirectory, "auth.token");
let shutdownRequested = false;
const health = {
  service: "codex-progress-hud",
  pid: process.pid,
  version: "0.1.0-smoke",
  protocolVersion: 1,
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
    "content-type": "application/json"
  };
  const identityResponse = await fetch(`${server.address().url}/health`);
  const identity = await identityResponse.json();
  const healthResponse = await fetch(`${server.address().url}/api/health`, { headers });
  const authenticatedHealth = await healthResponse.json();
  const eventResponse = await fetch(`${server.address().url}/api/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      taskId: "smoke-task",
      title: "Synthetic verification",
      event: {
        type: "model_progress",
        phase: "verification",
        progress: 0.5,
        confidence: 0.7,
        remainingSeconds: 60
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
    identity.protocolVersion !== 1 ||
    healthResponse.status !== 200 ||
    authenticatedHealth.protocolVersion !== 1 ||
    authenticatedHealth.instanceNonce !== health.instanceNonce ||
    eventResponse.status !== 202 ||
    snapshotResponse.status !== 200 ||
    snapshot.task?.status !== "running" ||
    snapshot.task?.progress !== 0.5 ||
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
