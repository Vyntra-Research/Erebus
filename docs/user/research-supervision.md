# Research and independent review

Erebus does not create research campaigns. A task can start, resume, change direction, or end without a research setup call. If the work needs a durable objective, use the native Codex/T3 goal.

## Research context

Erebus keeps a short set of rules in the principal and co-agent context. These cover realistic attacker control, evidence scope, natural exploit chains, dedupe, safe execution, anti-tunnel checks, and Post-AI blind spots.

The rules apply when the agent ranks, narrows, discards, reopens, or promotes a path. A failed test closes only the path it exercised. A check in one route does not prove that every route crosses it. New evidence must reopen any conclusion whose premise changed.

Argos is the connected memory for current research. Erebus installs its MCP and skills in the shared Codex profile. The agent updates canonical nodes and typed relations instead of copying the same fact into a second Erebus state. Each project's durable graph stays under `.argos/` in that project.

Proteus is legacy history in Erebus 0.6. The managed plugin exposes read-only lookup, status, and CVSS tools. It does not expose mutation tools or Proteus skills.

## Co-agents and subagents

Native provider subagents help with parallel work inside one bounded task. Erebus co-agent tasks cover separate horizontal sinks or surfaces. The principal assigns a distinct surface, checks progress, collects the handback, and releases the task when it is done.

A co-agent receives the same research rules, but it does not own the principal's goal and cannot submit a finding to the Judge. It returns evidence and artifact paths to the principal.

## Judge handoff

The `research` tool namespace has three operations:

- `research.get_status` reads stored submissions and verdicts.
- `research.submit_finding` submits revision 1.
- `research.revise_finding` submits a later revision after a technical verdict requests a change.

Both submission tools use this shape:

```json
{
  "findingId": "stable-finding-id",
  "revision": 1,
  "supersedesEvaluationId": null,
  "title": "Concise finding title",
  "target": "Product, version or ref, and tested topology",
  "findingPath": "findings/stable-finding-id.md",
  "pocPath": "pocs/stable-finding-id"
}
```

`findingPath` must name an existing file under `findings/`. `pocPath` must name an existing file or directory under `pocs/`, or it may be `null` when the finding explains why no PoC artifact applies. Paths are relative to the task workspace and cannot escape those directories.

The normal handoff contains only the finding and working PoC. Do not create a ZIP, checksum manifest, alternate deliverables directory, final report, or disclosure package for Judge review.

When a submission returns `accepted: true`, the agent ends its turn. The Judge reads the submitted artifacts in a separate bounded desk review. Erebus stores the result and starts a follow-up turn when the task is idle.

Judge verdicts mean:

- `accepted`: every required evidence gate passed.
- `revisionRequired`: the candidate is plausible but lacks a bounded proof or explanation.
- `rejected`: the evidence demonstrates a technical failure, artificial scenario, duplicate boundary, or missing practical impact.
- `invalidSubmission`: the submitted artifacts cannot be judged in their current form.
- `reviewBlocked`: the evaluator or evidence transport failed. Preserve the finding and retry the same unchanged revision after recovery.

CVSS classifies a proved finding. It does not decide whether the finding is valid.

## Settings

Use **Settings > Research** to choose the Judge model and reasoning effort. There is no Observer cadence or campaign setting in Erebus 0.6.

Existing campaign records from older Erebus releases remain in the local database for compatibility. Erebus 0.6 does not resume or mutate them.

## Proteus updates

Erebus checks its managed Proteus runtime against the latest stable release. When an update is available, the app shows the current and latest versions. The update control verifies the release metadata, installs the new runtime, and keeps the previous managed release for rollback. The runtime remains read-only inside Erebus.

## Argos updates

Erebus includes Argos 0.1.0 as a tested fallback and checks the latest stable Argos release separately. The app shows the current and latest versions. Both automatic and manual updates verify the exact release asset and its SHA-256 digest, then install the MCP and skills for enabled Codex accounts. The current and previous managed releases remain available, and project knowledge under `.argos/` is not replaced.
