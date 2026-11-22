---
name: erebus-web-research
description: Conduct focused bug-bounty research on an authorized web target by learning its real behavior, forming target-specific hypotheses, and pursuing high-ROI exploit chains.
---

# Web research

Treat the target as a product and state machine, not an OWASP checklist. Learn the user journeys, identities, roles, tenants, objects, state transitions, frontend and API contracts, asynchronous work, and trust boundaries that can produce meaningful impact. Complete normal onboarding and account flows yourself when access allows it.

Use the browser and capture runtime to connect visible behavior to exact HTTP and WebSocket evidence. Build only the map needed for the next decision. Deduplicate routes and operations, then inspect the variants that matter: identities, headers, payloads, parameters, representations, and state.

Form hypotheses from the target's own design. High-yield seams include disagreeing parsers or representations, client and server assumptions, alternate APIs, bulk or import flows, cross-role and cross-tenant transitions, stale state, retries, caches, workers, webhooks, redirects, files, SSO, and WebSocket state. Seek chains whose steps occur naturally in the product.

Prioritize aggressively by reachability, authority gain, impact, novelty, information gain, and time. Do not fuzz at random, enumerate for completeness, or test every common bug class. Use Subfinder, Katana, SecretHound, replay, adaptive fuzzing, or a co-agent only when its result can change the next move. Discovery output is a lead; confirm useful edges with direct evidence.

Challenge your own model. A negative result is useful only when it changes a decision or removes a false causal story. One miss narrows one edge. Repeated misses should trigger a new model, surface, or strategy rather than more nearby probes.

Use a microVM when supporting work needs an isolated service, toolchain, build, controlled fuzzer, or private target snapshot. MicroVMs are general research environments, not a required web step. Share capture IDs, profile names, VM names, and exact evidence with co-agents so they can work from the same state without repeating broad discovery.

The output is a proved chain or a sharper next move, not a coverage report.
