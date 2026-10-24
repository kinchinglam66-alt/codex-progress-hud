# Run on Windows

The research snapshot is a source distribution for Windows 10/11 x64. Its package
version is `0.2.1`, and the exact source baseline is recorded in
[RESEARCH-ARTIFACT.md](RESEARCH-ARTIFACT.md). There is currently no published
installer attached to this research release.

## Build and try the offline example

Use Node.js 22.13.0 or later and extract the source snapshot to a working directory.
Dependency installation downloads npm packages and Electron; it does not configure
an estimator account.

```powershell
npm ci
npm run typecheck
npm run build
node examples/offline-countdown.mjs
```

The example uses synthetic input. To open the desktop companion, use
`npm run start:hud`. Review [privacy](../PRIVACY.md) before granting estimator
authorization. A first launch is not an accuracy test.

## Plugin and companion entry points

The root `.mcp.json` is a development entry point using Node and the built
`dist/mcp/main.js`. The marketplace entry in `.agents/plugins/marketplace.json`
points to `plugins/codex-progress-hud`, whose native launcher expects a matching
packaged companion installation. Adding that marketplace alone does not install
the companion or turn a source checkout into a complete installed product.

For a developer building a matched local Windows companion and plugin:

```powershell
npm run verify:release
npm run release:artifacts
```

These commands create local artifacts, including the installer, plugin ZIP, and
`SHA256SUMS.txt`, under `release/`. Compare `Get-FileHash -Algorithm SHA256` for the
installer and ZIP with that file before running the per-user installer. Then
install the matching plugin in the host and restart the host. Windows may warn
about an unsigned installer. The native launcher build requires the Windows .NET
Framework C# compiler used by `scripts/build-native-launcher.mjs`.

`npm run pack:win` creates an unpacked companion for packaging checks. It does not
create the installer required by `npm run checksums`; use the complete maintainer
workflow above when producing distributable artifacts. Packaging commands do not
publish files or modify repository visibility.

With a matching companion installed, register the extracted marketplace from its root:

```powershell
codex plugin marketplace add .
```

Then use the desktop Plugins Directory to select the source, install or enable the
plugin, and restart the host. A local snapshot needs a local path; a published
repository version should use its actual published ref. The
[official packaging documentation](https://developers.openai.com/plugins/build/plugins)
describes current marketplace support. This project uses optional lifecycle Hooks;
the [official submission guidance](https://developers.openai.com/plugins/deploy/submission)
directs plugins depending on Hooks to manual desktop distribution. GitHub source
publication does not itself create a public-directory listing.

## Configure an estimator

In **设置** (Settings), inspect the source and recipient notice. Subscription mode
follows the main file-backed Codex account by default; independent-account and API
modes are separate options. See [account following](main-account-follow.md) and
[provider settings](observer-provider-settings.md). Full-context estimation sends
readable task text to the provider and may consume allowance or credit. Local
configuration checks do not prove successful inference or estimation accuracy.

## Controls and recovery

The host's plugin page controls global plugin enablement. Hiding the window and
pausing a row affect presentation or tracking, not the coding task. Use
**撤销估时授权** to revoke saved estimator authorization. After an update, restart
the host and use matching plugin and companion versions.

If forecasts are missing, inspect source availability, supported runtime hashes,
provider/account state, and local usage diagnostics. Keep unknown usage records.
A protocol mismatch, unavailable account check, and network failure require
different remedies. Deleting account data is not a general recovery step.

## Future compiled downloads

When a compiled release is published, verify its installer, plugin ZIP, and
checksum file from the same release. This preparation supplies no signed installer
or download URL for nonexistent artifacts. See [limitations](KNOWN-LIMITATIONS.md).
