---
name: erebus-evidence-testing
description: Design exact security tests that separate observation from inference and settle a live exploitability or impact question.
---

# Evidence testing

State the proposition before testing it. Name the attacker input, exact stable release, normal configuration, entry path, relevant state and authority, sink, and observable result.

Choose the smallest test that can distinguish the competing explanations. Use a focused harness, trace, debugger, protocol probe, browser flow, captured request, or manual black-box reproduction. Add a negative control when it can expose lab contamination, a forced condition, or a false causal link.

Record what happened and keep the conclusion inside the exercised producer, route, representation, state, authority, and consumer. A failed payload may not have reached the sink. A successful response difference may still lack security impact.

Use byte hashes only when byte identity itself proves a transformation or integrity boundary. Preserve exact commands, requests, outputs, and artifacts that another researcher needs to reproduce the claim.
