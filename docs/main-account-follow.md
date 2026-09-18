# Subscription account following

The desktop subscription provider follows the main Codex account by default.
The first authorization explicitly covers subsequent main-account switches.
An API provider is not changed by switching the Codex account.

## Modes

`observer-pilot.json` supports `subscriptionAccountSource`:

- Absent or `"main"`: read the main Codex file-backed ChatGPT login. The HUD
  does not perform a separate login or logout in this mode.
- `"independent"`: retain the separately authenticated subscription account.

The main home is resolved from the desktop environment's `CODEX_HOME`, or its
user profile `.codex` directory. Task text cannot supply this path. A missing,
expired, invalid, or unsupported login fails closed; it does not fall back to
the previous account. Keychain-only credentials and main API authentication
are not supported by the main subscription reader.

## Authentication and switching

The isolated, pinned observer runtime receives only the access token and
account metadata, using an ephemeral credential store. It does not copy a
refresh token or write the main login/configuration. All tools remain disabled.
External ChatGPT token authentication is experimental and tied to the verified
runtime capability; support for arbitrary future Codex versions is not claimed.

While subscription following is active, a local identity check runs every two
seconds. A changed or unavailable identity retires the old provider before
opening a replacement. Failed replacements back off for thirty seconds. This
polling is not an ETA/model request. A same-account token refresh does not by
itself discard the context session.

Model dispatch and interpretation delivery have account-identity fences in
addition to polling. A result from the old account cannot update the new
account's ETA. Known usage from a completed old request remains recorded for
the old account even if its interpretation is discarded.

## Authorization and accounting

An explicit `main-follow-v1` consent policy permits restoration after an
account switch while the HUD was closed. Other consent scope fields must still
match. Legacy and independent-account grants are not transferable; changing to
main-follow mode can require one new authorization.

Revocation disables retained runtimes and deletes the shared durable grant,
including when no runtime is currently selected during replacement. A storage
failure is reported rather than claiming successful durable revocation.

Per-account accounting and existing independent credentials are preserved.
Following an account does not reset usage, erase unknown usage records, change
API settings, or grant new model/tool permissions. Account metadata checks alone
do not establish ETA accuracy or prove an installed-version end-to-end switch.
