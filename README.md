# Codex Progress HUD

A local, privacy-first overlay for Codex task progress and honest remaining-time ranges. Community project; not affiliated with OpenAI.

## One plugin switch

Install, enable, disable, or uninstall Codex Progress HUD in Codex’s plugin page. That page is the only global switch. When the plugin is enabled and its command Hooks are trusted, tracking starts automatically for new Hook-enabled work; no start instruction is required.

After installing or updating, fully quit Codex Desktop and reopen it so the host reloads the plugin, Hooks, skill, and MCP definitions. Start a new task after the restart. An older conversation is best effort: it can attach when its first observed Hook arrives, but a frozen conversation from before installation cannot be reconstructed.

Window and task controls are separate presentation controls. Show/hide changes only window visibility. Per-task select, pause, resume, and stop changes only that task’s HUD presentation/timing. None of these controls enables or disables the plugin, and none pauses, cancels, or controls Codex execution. `hud_open`, `hud_close`, `hud_hide`, and `tracking_start` remain callable compatibility aliases where supported; they are not another global switch.

## Installation and troubleshooting

```powershell
npm ci
npm run build
npm run validate:plugin
```

If tools are missing, run `npm run diagnose:mcp`. If tools are present but the companion is offline, check the installed bundle and local executable. If versions mismatch, update both sides and fully restart Codex; do not mix an old MCP client with a new companion. `hud_diagnose` reports installation, Hook trust/activity, MCP lease, companion process, protocol compatibility, and per-task tracking separately.

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

See [PRIVACY.md](PRIVACY.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md), and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
