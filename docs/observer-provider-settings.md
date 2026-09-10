# Observer sources

This document describes the provider-selection candidate. Packaged and live
verification are separate release gates; passing local fixtures does not prove
that a particular account, endpoint, or model is available.

## Choose one source

- **ChatGPT subscription:** HUD uses its own login slot. Changing the account in
  the main Codex app does not automatically change the HUD account. Replace the
  HUD account through its account controls and complete the official login flow.
- **Responses-compatible API:** configure an HTTPS base URL, model, and API key.
  This is separately billed by that provider, not paid for by a ChatGPT
  subscription. The configured path prefix is retained when adding `responses`.

Only one source is selected. There is no automatic account rotation or fallback
from a failed API request to a subscription account. Both sources use the same
observer input and interpretation schema; choosing a source does not by itself
improve ETA accuracy.

## Quick start

Enable the plugin and open HUD settings. Choose one source and accept the inline
recipient/usage notice before starting:

- **ChatGPT subscription:** choose **登录并开始** and finish the official browser
  authorization. HUD verifies its independent account before starting estimation.
  An already authenticated HUD account can use **开始估时** without another login.
- **Responses-compatible API:** enter the HTTPS base URL, model, and key, then
  choose **保存并开始**. Review the recipient and billing notice beside the action.
  A retained key need not be entered again for the same saved profile and endpoint.

These primary actions explicitly authorize starting estimates; they are not
draft saves. No synthetic model trial is required. Ready means the source is
configured for estimation, not that a real model call has already succeeded.
Normal restarts reuse the saved active configuration and valid authorization.
Credentials can expire or be revoked, so a later login may occasionally be needed.

Cancel remains available beside the main action while connecting. Closing the
settings window cancels an unfinished connection/start operation; it does not
log out an account or erase a saved draft. Configuration edits clear the inline
acceptance so a changed recipient cannot inherit consent to the previous form.

Signing in to the ChatGPT website alone does not authorize HUD. Start the login
from HUD so the official browser flow can return credentials to its independent
login slot. HUD does not read browser cookies or copy the main Codex account.

## Advanced: save, check, trial, activate

The advanced **save draft** action must not send a model request or replace the active configuration,
including after restart. Local validation checks configuration shape only.
An authentication check is not an ETA test. A trial is a real synthetic model
request and may consume subscription allowance or API credit. Activation is the
separate step that permits estimates for observed tasks.

Review the recipient and billing notice before activating a new binding. A
changed endpoint or key must not silently inherit an unrelated authorization.
During a switch, old requests are closed before a new source can dispatch. Late
results must not update the new source's forecast, but their usage still belongs
in the original accounting history.

## Credentials and privacy

API secrets are write-only in the settings UI and encrypted at rest using the
operating system's protection facility. A configured-key indicator is not proof
that the key is valid. Do not paste keys, device codes, or login tokens into issue
reports or chat. Login is performed through the official authentication flow;
HUD does not copy the main Codex login cache.

An API endpoint receives observer input, including the selected task context.
Encryption at rest does not protect that context from the configured recipient.
Choose a provider whose data handling you accept. TLS verification remains on;
redirects are rejected rather than forwarding credentials to another location.

## Usage and failures

Use daily call and per-request output limits to bound routine consumption.
An output limit alone is not a dollar budget: input tokens also cost money.
Known usage is recorded even if an estimate cannot be parsed. Missing usage is
unknown, not zero, and an ambiguous dispatched request is not refunded locally.
Historical entries are retained when settings change.

Dollar estimates or caps require applicable, versioned prices covering the billed
token categories. Without that evidence, cost is unknown; do not interpret a local
token count as an exact provider invoice. Provider-side billing is authoritative.

Authentication failures require account/key/configuration correction. Temporary
network or service failures may receive at most one separately admitted automatic
retry for an observation, with backoff; they must not cause unbounded retry loops.
A damaged local ledger is a different problem and must not be reset to manufacture
unused allowance.

## Proxy troubleshooting

A browser login succeeding does not prove that the HUD process can reach the
model endpoint. Check the HUD runtime's configured proxy and trust environment.
Transport uses an explicit local dispatcher rather than changing the whole
process's network settings. Do not disable certificate verification to resolve
connection failures.

## Verification boundaries

The advanced local recovery check answers whether a recovery trial is eligible,
not whether an estimate is currently running. A normal or recovered state needs
no recovery trial; a failed check alone does not prove that estimation is disabled.
Provider actions refresh the recovery display after completion. One-step startup
reports a setup failure instead of treating unsuccessful initialization as ready.

Missing account metadata is not proof of logout. Settings distinguish an unchecked
account, a check in progress, a verified account, explicit login required, and an
unavailable check. Startup inspects the existing account before estimator setup,
so a later setup failure does not erase a successfully read account label. The
"检查账户并开始" action reuses valid credentials and only requests login when the
account inspector explicitly reports that login is required. No credential file
is deleted to repair a display or connectivity problem.

Local fixtures check parsing, cancellation, switching, accounting, and UI wiring
without real credentials. A successful synthetic trial checks connectivity and
schema compatibility, not ETA accuracy. Accuracy requires separate task samples
with independently determined completion times, excluding user waits and pauses.
