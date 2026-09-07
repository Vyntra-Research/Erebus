# Research supervision

Erebus allows one live research campaign per task. Separate tasks can run separate campaigns at the same time.

The principal Codex agent registers the campaign contract and starts the campaign. The Observer reviews completed assistant messages in fixed windows. It sends a live correction only when the evidence crosses the configured confidence threshold; a correction is never queued for a later turn after the task stops or pauses.

Erebus keeps a short, mandatory quality contract in every principal, Observer, Judge, and co-agent context. It covers scope, realistic attacker control, evidence, natural chains, depth, high-ROI continuity, dedupe, and promotion gates. Proteus provides the detailed research methods as installed skills. The agent loads `proteus:continuous-vuln-research` when a campaign starts or resumes, then loads only the specialist skill needed for the current task. Erebus refers to these skills by name instead of copying their full text into each prompt.

When the principal agent submits a finding, that submission ends its turn. The Judge then reviews the finding, its `findings/` record, its `pocs/` evidence, and the campaign gates independently. Erebus delivers the durable verdict in a later turn. Severity labels do not decide validity, and the Judge must not demand report packaging, ZIP files, or hashes as promotion gates.

Use **Settings -> Research** to set:

- completed assistant messages per Observer window
- minimum intervention confidence
- cooldown after an intervention
- an optional correction cap, unlimited by default
- evaluator model and reasoning effort

These are harness settings. A campaign agent cannot change the Observer cadence as a research decision.

## Proteus updates

Erebus checks the installed Proteus runtime against the latest stable release. When an update is available, it shows the current and latest versions at launch and under **Settings -> General**. The update control verifies the release metadata, installs the managed runtime, and keeps the previous managed release for rollback.

## Strict campaign payloads

Research control tools reject incomplete payloads without changing campaign state. The agent must use every required field and the exact type shown by the tool before moving to the next step.

Contract registration uses `{ campaignId, contract }`. Inside `contract`, `id` is the contract identifier and `target` is a required plain string. The target should name the product, repository, or service together with the version or ref and the deployment topology under test. Later lifecycle and finding calls refer to the registered identifier as `contractId`.
