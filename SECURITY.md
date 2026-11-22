# Security policy

## Scope

This policy covers vulnerabilities caused by Erebus itself, including its desktop app, local server, updater, credential handling, thread sync, web capture proxy, browser extension pairing, managed dependency installation, microVM control, and client-to-server authorization.

This channel covers flaws caused by Erebus. Vulnerabilities found in another product belong with that vendor or program. Dependency reports belong with the affected provider, module, runtime, or project unless Erebus introduces the unsafe behavior.

## Supported versions

Security fixes target the latest stable Erebus release. Report a beta-specific problem when stable remains unaffected.

## Private reports

Use [GitHub private vulnerability reporting](https://github.com/Vyntra-Research/Erebus/security/advisories/new) for undisclosed vulnerabilities. Public issues are appropriate after disclosure.

Include:

- the Erebus version and operating system
- the affected component and required setup
- realistic attacker control and impact
- exact reproduction steps
- the smallest proof needed to confirm the flaw
- logs or screenshots with credentials, tokens, private paths, and unpublished research removed

Vyntra Research reviews valid reports and coordinates disclosure as maintainer time permits. Bug bounties and payments are outside this policy.
