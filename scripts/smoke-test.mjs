import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgressServer } from "../dist/server/http-server.js";

const directory = await mkdtemp(join(tmpdir(), "codex-progress-hud-smoke-"));
const tokenPath = join(directory, "auth.token");
const server = createProgressServer({ port: 0, tokenPath });

try {
  await server.listen();
  const token = (await readFile(tokenPath, "utf8")).trim();
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json"
  };
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
  if (
    eventResponse.status !== 202 ||
    snapshotResponse.status !== 200 ||
    snapshot.task?.status !== "running" ||
    snapshot.task?.progress !== 0.5
  ) {
    throw new Error("smoke verification returned an unexpected snapshot");
  }
  process.stdout.write("Smoke test passed: authenticated event reached the live snapshot.\n");
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}

