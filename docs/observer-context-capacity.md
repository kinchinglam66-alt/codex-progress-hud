# Observer context capacity

The local HUD process accepts `CODEX_PROGRESS_HUD_CONTEXT_KIB=16`, `32`, or `64`.
Unset or invalid values use 16 KiB. This caps the complete UTF-8 JSON input packet,
including metadata, not tokens and not the separate system instructions or response.
Larger settings may increase input usage and inference latency; they do not guarantee
better estimates. The model and request frequency are unchanged.

Set the variable in the environment that launches the HUD, before starting that
process. For example, in PowerShell before launching your locally built HUD:

```powershell
$env:CODEX_PROGRESS_HUD_CONTEXT_KIB = '32'
npm run start:hud
```

For an installed plugin, the launcher must inherit that environment. Setting the
variable in an unrelated terminal does not update an already running Codex/HUD.
Restart the launcher/HUD using the configured environment. A settings-page control
is not included yet. No login reset or additional consent is required for this flag.

Both context assembly and final provider packing honor the same process setting.
Individual message limits, credential filtering, message count limits and omission
markers remain active. Larger packets cannot recover upstream records already lost.
Record the capacity when comparing evaluations; retain the default baseline.

Under pressure, current-turn requirements and the latest tool event plus its
available matching call/result are preferred over background and older tool logs.
The latest result is retained alongside an unfinished newer call, so starting a
rerun does not erase the previous failure evidence.
Long retained messages are shortened using an explicit head/tail omission marker;
this is deterministic clipping, not a model-generated semantic summary. Truncation
and missing counterparts remain marked. Concise amendments are preserved ahead of
verbose retained text where possible. No finite packet can preserve every detail.

The observer is prompted to account for relevant implementation, testing, rework
and delivery stages, and not to treat an assistant's "last check" claim as proof of
imminent completion. This is an input-quality fix; measured ETA accuracy improvement
requires a separate held-out evaluation. Native completion signals are unchanged.
