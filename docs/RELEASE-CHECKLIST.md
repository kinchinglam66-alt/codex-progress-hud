# Windows release checklist

- [ ] Use a clean checkout of the release commit.
- [ ] Confirm package, root plugin, nested plugin, generated capability, and tag versions match.
- [ ] Run `npm ci --registry=https://registry.npmjs.org` with Node 22 and confirm the lockfile has no alternate registry URLs.
- [ ] Run `npm run verify:release` and `npm run diagnose:mcp`.
- [ ] Run `npm run release:artifacts`, `npm run smoke:packaged`, and `npm run diagnose:mcp:packaged` on Windows x64.
- [ ] Confirm the installer, plugin ZIP, and `SHA256SUMS.txt` have exact 0.2.0 names.
- [ ] Verify checksums independently with `Get-FileHash`.
- [ ] Install per user and confirm `%APPDATA%\codex-progress-hud\install.json` points to the exact installed EXE inside its installation directory.
- [ ] Confirm the wrapped `mcpServers` `.mcp.json` is parsed by Codex and `--hud`, `--mcp-stdio`, and every packaged Hook mode, including `Interrupt`, work without a global Node installation.
- [ ] Exercise automatic new-task tracking, older-task late attachment, two concurrent tasks, pin/follow, show/hide, pause/resume/stop, mismatch guidance, final lease expiry, crash recovery, and fail-open Hooks.
- [ ] Disable/re-enable the plugin and verify both final-lease and Hook-started/zero-lease shutdown paths.
- [ ] Confirm the release workflow force-rebuilds the native bridge from `build/native-launcher.cs` and all Actions are pinned to full commit SHAs.
- [ ] Uninstall once retaining data and once removing data; confirm only the expected manifest is removed automatically.
- [ ] Scan the repository and artifacts for secrets, absolute developer paths, caches, source maps, logs, tokens, and test files.
- [ ] Review the unsigned-installer disclosure and GitHub draft release before publishing.
- [ ] After publication, download all artifacts from GitHub and verify their checksums again.
