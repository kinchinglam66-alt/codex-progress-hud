# Privacy and data flow

Codex Progress HUD runs a local desktop companion and has no project-operated
cloud backend or telemetry. Independent estimation uses the provider selected by
the user. This policy describes the research source snapshot based on commit
`40b81e6bb8f23cd25bcfac3f7c5106b0d3ad58f7`; older engineering notes may describe
earlier, more limited observation paths.

## Readable task content

The full-context observer reads supported existing local conversation records for
the authenticated conversation and current turn, including earlier readable user,
assistant, and tool records. A fixed readable cutoff binds each request. It does
not promise access to hidden reasoning, arbitrary attachments, or every host
format. Missing history and unavailable images are tracked as gaps.

When the user explicitly enables estimation, readable task text can be sent to the
selected subscription or API provider without task-text redaction. Confidential
material already in a conversation can therefore be sent again. An API endpoint
can represent a different recipient from the service executing the coding task.
Review the recipient notice in Settings before authorizing it.

Capacity overflow can trigger history compression using the selected estimator
service, adding requests and possible information loss. The history feature uses
bounded in-memory caches; it does not create a persistent raw transcript cache.
The original conversation source remains managed by the host.

## Accounts and authorization

Subscription estimation follows the verified file-backed main Codex account by
default. The isolated supported runtime receives an access token and account
metadata through an ephemeral credential path. It does not copy refresh tokens
or rewrite the main login. Independent subscription login is a separate mode.
API mode uses the user's configured endpoint, model, and key.

Saved consent binds the configured source and the stated account-following policy.
Switching identity retires the previous provider and fences late results. Revoke
estimator consent in Settings to remove its durable authorization. A hidden
window or paused tracking is not a substitute for revoking estimator consent or
disabling the plugin. See [account following](docs/main-account-follow.md).

API secrets are write-only in Settings and use the protected local secret store.
Do not enter credentials into task messages or commit local account files.
The application does not read browser cookies.

## Local metadata and records

Loopback communication uses local authentication. Lifecycle projections and
diagnostics use bounded state, counters, identities, versions, and timestamps.
Chat names can appear on the local desktop; their metadata path is distinct from
task content supplied for estimation. Optional Hooks accept an allowlisted event
schema and transform session/turn identifiers into opaque keys.

Known usage, reservations, and unresolved or unknown usage remain in durable local
accounting. Observer research journals record structured metadata and numeric
outcomes, not the raw task transcript. Existing host logs, host source files, and
explicit developer exports have their own storage lifecycle. Review any diagnostic
or research export before sharing it.

## Network and costs

The companion listens on authenticated loopback. Explicitly enabled estimation,
necessary compression, and explicitly requested synthetic trials can contact the
selected provider and consume allowance or API credit. Provider retention and
billing policies apply; the project does not promise zero provider retention or
an exact invoice from local token counters. Dependency downloads and host account
operations are separate network activity.

## Limits and reporting

Processes running as the same compromised OS user may access application data or
credentials. Local authentication does not eliminate that risk. Runtime admission,
consent checks, account fences, and structured diagnostics address particular
boundaries rather than every possible compromise.

Use [SECURITY.md](SECURITY.md) to report a vulnerability without including real
tokens or private conversations. The current data flow is also described in
[full-context estimation](docs/FULL-CONTEXT-ESTIMATION.md) and the
[threat model](docs/THREAT_MODEL.md).
