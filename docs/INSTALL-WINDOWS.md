# Install on Windows

Codex Progress HUD 0.2.0 supports Windows 10/11 x64. The companion installer is currently unsigned, so Windows SmartScreen may ask you to review the publisher warning.

## Verify and install

Download these three files from the same GitHub release:

- `Codex-Progress-HUD-Setup-0.2.0.exe`
- `codex-progress-hud-plugin-0.2.0.zip`
- `SHA256SUMS.txt`

Verify the downloads before running them:

```powershell
Get-FileHash .\Codex-Progress-HUD-Setup-0.2.0.exe -Algorithm SHA256
Get-FileHash .\codex-progress-hud-plugin-0.2.0.zip -Algorithm SHA256
```

Compare both lowercase hashes with `SHA256SUMS.txt`, then run the companion installer. It installs per user without elevation and does not enable login startup.

Add and enable the plugin through Codex's plugin page. For a Git checkout, the equivalent CLI flow is:

```powershell
codex plugin marketplace add kinchinglam66-alt/codex-progress-hud --ref main
codex plugin add codex-progress-hud@kinchinglam66-alt
```

Review and trust the plugin Hooks when Codex asks. Fully quit and reopen Codex once. Tracking then starts automatically; no per-task activation phrase is required. A resumed older conversation may attach on its first observed Hook, without backfilling earlier elapsed time. If that conversation retained a pre-install plugin snapshot, start or fork a continuation task.

The release plugin includes a small open-source Windows bridge compiled from `build/native-launcher.cs`. It validates the installer manifest and streams MCP JSON directly to the packaged companion, avoiding a global Node.js dependency and PowerShell's non-streaming redirected-input behavior.

## Controls and lifecycle

The Codex plugin page is the only global enable/disable/uninstall switch. Show/hide changes only the floating window. Select, pause, resume, and stop affect only one task's HUD timing and never pause or stop Codex itself.

Disabling or uninstalling stops new plugin activity. The companion exits after the final MCP lease disappears and a 30–60 second grace period. The deprecated `hud_close` alias requests immediate shutdown but does not persist an off preference; an enabled task may restart the companion.

## Update and recovery

Install matching plugin and companion versions, then fully restart Codex. A version mismatch is reported separately from an offline companion. If tools or Hooks remain stale, disable and re-enable the plugin or reinstall both artifacts from the same release, then restart again.

Run `hud_diagnose` when available. Diagnostic reports contain bounded state categories and timestamps, not tokens, prompts, task titles, source files, raw session IDs, Hook payloads, or command output. Review a report before sharing it.
