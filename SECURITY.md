# Security policy

## Scope

This policy covers vulnerabilities caused by Erebus itself, including its desktop app, local server, updater, credential handling, thread sync, managed dependency installation, and client-to-server authorization.

Do not use this channel for a vulnerability that Erebus helped you find in another product. Report that issue to the affected vendor or program. Problems that exist only in Codex, Argos, Proteus, Git, or another dependency should go to that project unless Erebus introduces the unsafe behavior.

## Supported versions

Security fixes target the latest stable Erebus release. Report a beta-specific problem when it does not reproduce on stable.

## Private reports

Use [GitHub private vulnerability reporting](https://github.com/Vyntra-Research/Erebus/security/advisories/new). Do not open a public issue for an undisclosed vulnerability.

Include:

- the Erebus version and operating system
- the affected component and required setup
- realistic attacker control and impact
- exact reproduction steps
- the smallest proof needed to confirm the flaw
- logs or screenshots with credentials, tokens, private paths, and unpublished research removed

Vyntra Research will review valid reports and coordinate disclosure. This project does not promise a bug bounty, payment, or a fixed response time.
