const [moduleUrl, pathsJson, iterationsText, workerText] = process.argv.slice(2);
if (!moduleUrl || !pathsJson || !iterationsText || !workerText) {
  throw new Error("state-store worker arguments are required");
}

const { createLifecycleStateStore } = await import(moduleUrl);
const store = createLifecycleStateStore(JSON.parse(pathsJson));
const iterations = Number(iterationsText);
const worker = Number(workerText);

for (let index = 0; index < iterations; index += 1) {
  const settings = await store.setDesiredState((worker + index) % 2 === 0 ? "on" : "off");
  await store.readSettings();
  const identity = {
    pid: process.pid,
    version: "0.2.0-test",
    protocolVersion: 1,
    instanceNonce: `worker-${worker}-${index}`,
    startedAt: new Date(1_700_000_000_000 + index).toISOString()
  };
  await store.writeRuntime(identity);
  await store.readRuntime();
  if ((worker + index) % 3 === 0) await store.clearRuntime();
  if (!Number.isSafeInteger(settings.generation)) throw new Error("invalid generation");
}

process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
