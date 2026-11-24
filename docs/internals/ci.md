# CI quality gates

> For maintainers. Using Erebus? See [docs/user](../user/).

[`ci.yml`](../../.github/workflows/ci.yml) is the pull-request gate. It is intentionally small:

- **Plan** classifies the diff and skips unrelated work.
- **Quality** runs `vp check` and `vpr typecheck` for the whole workspace.
- **Smoke** runs `pnpm test:smoke`, a curated critical-path suite that must pass on Windows and
  Linux.
- **Build** builds the server, web, and desktop pipelines only when product code changes.
- **Native** runs Rust formatting, checks, Clippy, and tests only when a native crate changes. The
  desktop release workflow builds the Windows-only Computer Use runtime.
- **CI** is the single aggregator required by branch protection.

The full unit suite is not on the pull-request path. It runs in
[`full-tests.yml`](../../.github/workflows/full-tests.yml) on a weekly schedule or by manual
dispatch, together with the smoke suite on Windows. This keeps feedback for a one-person project
fast while still giving the deeper suite a home.

`release.yml` starts after CI passes on a merged `main` pull request. A metadata gate resolves the
version and reuses an existing release. Windows and Linux jobs then build the unsigned Windows x64
installer and Linux x64 AppImage in parallel. The Linux job extracts the AppImage and checks its
payload. After both builds pass, one publish job tags the tested revision and publishes both apps
and their update metadata in one GitHub Release. A final job advances the managed `beta` or
`stable` channel branch.

See [Testing](./testing.md) for what the suites cover and
[Release Checklist](../operations/release.md) for signing and release setup.
