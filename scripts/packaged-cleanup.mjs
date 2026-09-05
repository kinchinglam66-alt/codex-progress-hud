import { rm as removeDirectory } from "node:fs/promises";

const RETRYABLE_REMOVAL_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function assertToolSuccess(result, name) {
  if (result.isError === true || result.structuredContent?.ok !== true) {
    throw new Error(`packaged ${name} failed: ${JSON.stringify(result.structuredContent ?? {})}`);
  }
}

export function assertHudCloseStopped(result, context) {
  assertToolSuccess(result, "hud_close");
  if (result.structuredContent?.observedState !== "stopped") {
    throw new Error(`${context} hud_close did not observe stopped state: ${JSON.stringify(result.structuredContent ?? {})}`);
  }
}

export async function removeTemporaryDirectory(
  path,
  remove = removeDirectory
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await remove(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error?.code;
      if (!RETRYABLE_REMOVAL_CODES.has(code ?? "") || attempt >= 15) throw error;
      await delay(Math.min(50 * 2 ** attempt, 500));
    }
  }
}

export async function runPackagedCleanup({
  connect,
  open,
  work,
  close,
  emergencyClose = close,
  release,
  cleanup,
  reportCleanupError = (error, context) => {
    console.error(`Packaged ${context} cleanup failed:`, error);
  }
}) {
  let cleanupArmed = false;
  let closeAttempted = false;
  let closed = false;
  let result;
  let primaryError;

  const recordFailure = (error, context) => {
    if (primaryError === undefined) {
      primaryError = error;
    } else {
      reportCleanupError(error, context);
    }
  };

  const closePrimary = async () => {
    closeAttempted = true;
    await close();
    closed = true;
  };

  try {
    await connect();
    cleanupArmed = true;
    await open();
    result = await work(closePrimary);
  } catch (error) {
    primaryError = error;
  } finally {
    if (cleanupArmed && !closed) {
      if (!closeAttempted) {
        try {
          await closePrimary();
        } catch (error) {
          recordFailure(error, "primary HUD close");
        }
      }
      if (!closed) {
        try {
          await emergencyClose();
        } catch (error) {
          reportCleanupError(error, "emergency HUD close");
        }
      }
    }

    try {
      await release();
    } catch (error) {
      recordFailure(error, "MCP release");
    }
    try {
      await cleanup();
    } catch (error) {
      recordFailure(error, "temporary-directory");
    }
  }

  if (primaryError !== undefined) throw primaryError;
  return result;
}
