---
name: erebus-chain-discovery
description: Develop realistic, non-obvious exploit chains from a concrete primitive, authority transition, state change, side effect, or sink.
---

# Chain discovery

Start from a proved primitive and ask what it changes for the next operation. Useful outputs include a value, identity, capability, durable state, reordered event, alternate representation, or side effect that crosses a new boundary.

Reason forward from the primitive and backward from plausible impact. Inspect target-specific handoffs: alternate consumers, workers and queues, cache or retry behavior, tenant and role changes, parser differences, file or URL transforms, native boundaries, stale reads, and time-of-check gaps. Prefer natural product flows and common correct configurations.

Do not stop at the first familiar exploit story. Compare it with at least one less obvious route that uses the target's own architecture. Test the smallest intersection that can confirm or kill the chain.

Reject chains that need invented credentials, manual database edits, skipped checks, unsupported deployment state, reduced permissions, or lab glue. Keep partial gadgets as reusable evidence even when the full chain fails.
