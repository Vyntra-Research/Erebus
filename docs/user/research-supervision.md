# Research supervision

Erebus allows one live research campaign per task. Separate tasks can run separate campaigns at the same time.

The principal Codex agent registers the campaign contract and starts the campaign. The Observer reviews completed assistant messages in fixed windows. It sends a live correction only when the evidence crosses the configured confidence threshold; a correction is never queued for a later turn after the task stops or pauses.

When the principal agent submits a finding, that submission ends its turn. The Judge then reviews the finding, its `findings/` record, its `pocs/` evidence, and the campaign gates independently. Erebus delivers the durable verdict in a later turn. Severity labels do not decide validity, and the Judge must not demand report packaging, ZIP files, or hashes as promotion gates.

Use **Settings -> Research** to set:

- completed assistant messages per Observer window
- minimum intervention confidence
- cooldown after an intervention
- an optional correction cap, unlimited by default
- evaluator model and reasoning effort

These are harness settings. A campaign agent cannot change the Observer cadence as a research decision.
