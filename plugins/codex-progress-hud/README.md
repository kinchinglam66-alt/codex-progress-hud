# Codex Progress HUD

A local, privacy-first overlay for Codex task progress and honest remaining-time ranges. Community project; not affiliated with OpenAI.

## One plugin switch

Install, enable, disable, or uninstall Codex Progress HUD in Codex’s plugin page. That page is the only global switch. Enablement loads the plugin capabilities; it does not force model progress calls. Task tracking occurs when the model reports, using a supplied opaque handle when available or the MCP-process lease fallback otherwise. After a fallback task reaches a terminal state, an explicitly requested handle-free `tracking_start` creates one fresh fallback task and preserves the old record; ordinary progress and delayed reports never roll over automatically.

After installing or updating, fully quit Codex Desktop and reopen it so the host reloads the plugin, optional Hooks, skill, and MCP definitions. An existing conversation can report after the restart without backfilling prior activity. A frozen conversation from before installation cannot be reconstructed.

Window and task controls are separate presentation controls. Show/hide changes only window visibility. Per-task select, pause, resume, and stop changes only that task’s HUD presentation/timing. None of these controls enables or disables the plugin, and none pauses, cancels, or controls Codex execution. `hud_hide` is an ordinary window-visibility alias, not a deprecated lifecycle alias. `hud_close` is a deprecated compatibility alias for an immediate shutdown request; it does not persist a global off preference. These aliases are not another global switch.

## Windows installation and troubleshooting

Install the Windows companion first, then add and enable the matching release plugin in Codex. Hooks are optional best-effort compatibility support; review or trust them only if you want those signals. Fully restart Codex once. The installer is per-user, requires no global Node.js, and is unsigned until a trusted signing certificate is configured. See [Install on Windows](https://github.com/kinchinglam66-alt/codex-progress-hud/blob/main/docs/INSTALL-WINDOWS.md) for checksum, install, update, disable, and uninstall instructions.

If tools are missing, run `npm run diagnose:mcp`. If tools are present but the companion is offline, check the installed bundle and local executable. If versions mismatch, update both sides and fully restart Codex; do not mix an old MCP client with a new companion. `hud_diagnose` reports plugin enablement, Hook trust/activity, MCP lease, companion process, protocol compatibility, and per-task tracking separately. Multiple conversations sharing one MCP process cannot be distinguished by the fallback lease.

## Privacy-bounded Hooks

The adapter accepts only `session_id`, optional `turn_id`, optional `tool_use_id`, optional `hook_event_name`, and optional `source` (`startup`, `resume`, `clear`, or `compact`). It validates and then discards raw Hook input. `session_id` and `turn_id` are HMAC-hashed into opaque keys; the event identity also hashes the Hook name, source, and tool-use identifier. Prompts, transcript paths, tool input/output, cwd, arbitrary fields, titles, and secrets are discarded and never sent or stored.

Operational history is bounded codes and canonical timestamps only. It contains no token, raw session ID/handle, title, prompt, path, Hook payload, or secret. Diagnostics are local and safe to review before sharing.

## Development

```powershell
npm test -- --run
npm run typecheck
npm run build
npm run validate:plugin
npm run diagnose:mcp
```

See [known side effects and limitations](docs/KNOWN-SIDE-EFFECTS.md), [PRIVACY.md](PRIVACY.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md), and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
