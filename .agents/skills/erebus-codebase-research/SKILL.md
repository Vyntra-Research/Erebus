---
name: erebus-codebase-research
description: Map a security-relevant codebase area into decisions, trust boundaries, authority, state, transformations, guarantees, and sinks.
---

# Codebase research

Map decisions, not files. Pick the request path, parser, worker, state transition, trust boundary, or sink that can produce meaningful impact, then follow the real implementation through wrappers, generated code, native code, protocols, storage, and upstream components when they own part of the behavior.

Prioritize unexplained handoffs, transforms that disagree, conditional guarantees, authority changes, durable state, alternate consumers, and checks whose inputs or timing are unclear. For each security check, identify who supplies its inputs, which callers reach it, when it runs, how later code reinterprets the value, and which defaults or versions change it.

Search existing findings, reports, discarded candidates, and connected memory before deep investment. Treat history and diffs as supporting intel unless the task is about a patch.

The useful result is a compact model that changes the next test: reachable paths, attacker-controlled values, authority at each step, decisive sinks, open relations, and the highest-ROI hypothesis. Do not build a file catalog or broad audit inventory.
