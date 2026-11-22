---
name: erebus-adaptive-fuzzing
description: Use feedback-led fuzzing to learn a specific parser, protocol, state machine, or sink when code reading and focused probes cannot settle its behavior.
---

# Adaptive fuzzing

Use fuzzing to answer a live question, not to spray payloads or claim coverage.

Model the path first: attacker-controlled input, transformations, parser or state transition, security-relevant consumer, and an observable signal. Start from valid examples and mutate one meaningful property at a time. Prefer target grammar, normalization boundaries, parser disagreements, state transitions, and downstream constraints over generic dictionaries.

Keep inputs that reveal new behavior, state, coverage, authority, or sink reachability. Reduce them until the decisive property is clear. Treat crashes, timeouts, status changes, traces, sanitizer reports, and response differences as signals that still need interpretation.

Use a persistent microVM when the harness needs an isolated toolchain, sanitizers, private source snapshot, target service, or a long-running job. Copy out only the artifacts needed to reproduce the result.

Stop or change strategy when repeated mutations produce no new information. A miss narrows the exercised path; it does not prove the sink safe or require abandoning a promising line.
