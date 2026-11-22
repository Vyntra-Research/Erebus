# Research and independent review

Research begins directly in any task. Codex tasks can use the native goal when the work needs a durable objective.

Older Codex tasks keep the tool schemas they received when first created. Erebus uses the authenticated `erebus-research` fallback when those schemas differ from the current tools. This preserves the task's history and finding state. The fallback supplies the current Research and Judge tools.

## Research context

Erebus keeps a short set of rules in the principal and co-agent context. These cover realistic attacker control, evidence scope, natural exploit chains, dedupe, safe execution, anti-tunnel checks, and Post-AI blind spots.

The rules apply when the agent ranks, narrows, discards, reopens, or promotes a path. A failed test closes the path it exercised. Protection claims stay bounded to the routes covered by evidence. New evidence reopens any conclusion whose premise changed.

Argos is the connected memory for current research. Erebus installs its MCP and operational skill for enabled providers. The agent records canonical nodes and typed relations directly in each project's `.argos/` graph.

Erebus also supplies eight research skills: codebase research, web research, chain discovery, exploit validation, evidence testing, adaptive fuzzing, external intelligence, and finding reports. They are focused references, not a mandatory checklist. The agent uses the ones that help the current path.

## Co-agents and subagents

Native provider subagents help with parallel work inside one bounded task. Erebus co-agent tasks cover separate horizontal sinks or surfaces. The principal assigns a distinct surface, checks progress, collects the handback, and releases the task when it is done.

Linked threads keep co-agents in the same project. Standalone threads can also create co-agents; those children remain isolated from other standalone threads.

A co-agent receives the same research rules and returns evidence and artifact paths to the principal. The principal owns the goal and Judge submission.

## Judge handoff

The `research` tool namespace has four operations:

- `research.calculate_cvss` validates and scores an explicit CVSS 3.0, 3.1, or 4.0 vector.
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

`findingPath` must name an existing file under `findings/`. `pocPath` must name an existing file or directory under `pocs/`; use `null` with an explanation when a PoC artifact is inapplicable. Paths are relative to the task workspace and stay within those directories.

The Judge handoff consists of the finding and working PoC.

When a submission returns `accepted: true`, the agent ends its turn. The Judge reads the submitted artifacts in a separate bounded desk review. Erebus stores the result and starts a follow-up turn when the task is idle.

Judge verdicts mean:

- `accepted`: every required evidence gate passed.
- `revisionRequired`: the candidate is plausible but lacks a bounded proof or explanation.
- `rejected`: the evidence demonstrates a technical failure, artificial scenario, duplicate boundary, or missing practical impact.
- `invalidSubmission`: the submitted artifacts cannot be judged in their current form.
- `reviewBlocked`: the evaluator or evidence transport failed. Preserve the finding and retry the same unchanged revision after recovery.

CVSS classifies a proved finding. Pass a complete explicit vector to `research.calculate_cvss` after the evidence establishes validity.

## Settings

Use **Settings > Research** to choose the Judge model and reasoning effort.

## Argos updates

Erebus includes Argos 0.1.0 as a tested fallback and checks the latest stable Argos release separately. The app shows the current and latest versions. Both automatic and manual updates verify the exact release asset and its SHA-256 digest, then install the MCP and operational skill for enabled providers. The current and previous managed releases remain available, and project knowledge under `.argos/` stays intact.
