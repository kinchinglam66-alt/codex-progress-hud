# Windows shared HUD data

Windows HUD state now lives in `%USERPROFILE%\.codex-progress-hud`.
`CODEX_PROGRESS_HUD_DATA_DIR` remains an explicit isolated-profile override;
`CODEX_PROGRESS_HUD_TOKEN_PATH` remains an explicit token-path override.
MCP, Hook and desktop processes must use the same overrides when connecting.
Electron's profile lives in the selected data directory's `electron` subfolder.

## Why AppData was replaced

MSIX applications can see a merged AppData view backed by a private package
directory. A HUD launched by a packaged Codex host and one launched by Explorer
could therefore read different tokens and settings at the same apparent path.
The shared directory deliberately sits outside AppData. The launcher does not
silently fall back to old AppData: doing so would recreate split ownership.

## Existing installations

An existing installation needs an explicitly reviewed offline migration before
switching all entry points. Do not reset consent or generate a replacement token.
Keep the original physical and package-private data for rollback. Verify which
source contains the active provider, consent and accounting history; do not merge
two ledgers or accounts by timestamps alone.

`migrateHudData` in `src/lifecycle/data-directory-migration.ts` performs a bounded
copy with exclusive staging, per-file hashes, source-change detection and writer
checks before publication. Windows callers must secure staging to the current
user and SYSTEM before any credentials are copied. An existing destination is
never overwritten. Failures retain staging for inspection and never remove the
source. The private migration report lists every copied and omitted entry.

Durable HUD configuration, ledgers, observations, research records and relevant
Electron profile files are preserved. Stale runtime identities, process locks,
graphics caches and inactive legacy `local-pilot` directories are not activated
in the new profile. Configured external runtime/account-home paths are unchanged.
Stop all HUD writers before copying SQLite databases and verify their integrity.

Upgrade the desktop archive, native MCP/Hook launcher and fallback scripts
together; reinstall the plugin from its existing local marketplace. Updating only
one entry point is insufficient. Future installers write their manifest in the
shared directory; uninstall only deletes user data after explicit confirmation.

## Acceptance

Verify from both packaged-host and Explorer launches: identical startup path
fingerprints and settings generation, successful direct loopback authentication,
account availability without re-login, preserved usage, and a real task visible
to the HUD. A working health endpoint alone does not prove ETA recovery.
