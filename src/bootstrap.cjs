'use strict';

function start({
  argv = process.argv,
  electronRuntime = process.versions.electron,
  loadElectron = () => require('electron'),
  loadMain = async () => {
    const main = await import('./main.js');
    // Electron executes main.js on import. Node's direct-entry check correctly
    // does not, because its argv points at this bootstrap instead.
    if (!electronRuntime) await main.runSelectedMode(argv);
  }
} = {}) {
  // CommonJS executes synchronously, before the asynchronous ESM application
  // can let Electron reach ready. Never initialize GUI APIs in Node/MCP/Hook mode.
  const headless = argv.includes('--mcp-stdio') || argv.includes('--automatic-login') ||
    argv.some(argument => argument.startsWith('--hook-event'));
  if (electronRuntime && !headless) loadElectron().app.disableHardwareAcceleration();
  return loadMain();
}

module.exports = { start };

if (require.main === module) {
  try {
    Promise.resolve(start()).catch(() => {
      console.error('HUD_BOOTSTRAP_FAILED');
      process.exitCode = 1;
    });
  } catch {
    console.error('HUD_BOOTSTRAP_FAILED');
    process.exitCode = 1;
  }
}
