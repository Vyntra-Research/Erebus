# Testing

> For maintainers. Using Erebus? See [docs/user](../user/).

Erebus is a personal open-source project. The test suite exists to answer one question: does the
product still work? It is not a compatibility matrix and it is not a specification of prompts,
tool names, or internal constants.

## The two suites

| Suite | Command                         | Where                 | Purpose                                                |
| ----- | ------------------------------- | --------------------- | ------------------------------------------------------ |
| Smoke | `pnpm test` / `pnpm test:smoke` | Windows, Linux, macOS | Critical paths that must never regress                 |
| Full  | `pnpm test:full`                | Linux only            | Deeper unit coverage, run from the Full Tests workflow |

The smoke suite is the default local and pull-request gate. It is deliberately small and
cross-platform.

### Smoke coverage

- Server: MCP HTTP surface and credential registry, SQLite persistence and migrations, provider
  orchestration capabilities, web-runtime client.
- Desktop: backend path/configuration resolution, browser profile registry, Electron shell
  startup contract.
- Web: right-panel state, extension automation routing, preview automation errors.
- Contracts: settings and web-runtime schemas.
- Scripts: the CI change classifier.

Everything else is deeper coverage and belongs to the full suite.

## What we do not test

- Prompt text, developer instructions, or generated skill text.
- That a particular tool exists or that its schema matches a literal snapshot.
- Large generated JSON schemas or generated source files.
- Host-specific behavior such as symlink support, executable bit permissions, CRLF output, or
  spawning a fixture binary. These differ by platform and say nothing about the product.
- Constants, copy, and formatting that a typecheck or review already catches.

If a test would only fail when someone deliberately edits the asserted literal, it is not a test.

## Platform rules

- The smoke suite must pass on Windows and Linux. Use `node:path`, temporary directories,
  `process.execPath` for child Node processes, and normalize line endings before comparing text.
- Do not branch on `process.platform` in product code just to satisfy a test. Inject the host
  platform, the runtime path, or the capability through an Effect service or configuration, as
  `ProviderService` does for Computer Use.
- Tests that genuinely need a host behavior are isolated in the full suite, which runs on Linux.
  The Full Tests workflow also runs the smoke suite on Windows to catch accidental platform
  coupling before it reaches the default path.
- Never make the default `pnpm test` depend on Electron, a browser, a real provider CLI, or the
  network.

## Adding a test

Before adding one, ask:

1. What user-visible behavior breaks if this regresses?
2. Is it covered by the smoke suite already?
3. Can the assertion be written as a contract (input → observable output) instead of an equality
   on implementation text?

Put it in the smoke suite only when it is critical and cross-platform. Otherwise leave it in the
package suite for the full run. Keep the pull-request pipeline under a few minutes; a test that
spends that budget debugging its own runner is worse than no test.
