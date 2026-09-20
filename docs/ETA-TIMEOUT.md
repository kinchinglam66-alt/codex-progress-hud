# ETA total deadline

The optional end-to-end ETA deadline is disabled by default. Set
`CODEX_PROGRESS_HUD_ESTIMATE_TIMEOUT_MS=0` to disable it explicitly, or use a
positive integer number of milliseconds (for example `30000`). Restart the
companion after changing the environment setting.

Disabling this deadline does not disable cancellation when the source turn
ends, the user interrupts, or the plugin shuts down. Transport, model-session,
cleanup and accounting safeguards remain independent. It does not guarantee
that an external model request will succeed or wait indefinitely.
