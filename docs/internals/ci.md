# CI quality gates

> For maintainers. Using Erebus? See [docs/user](../user/).

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs these quality gates on pull requests
and pushes to `main`:

- **Check**: `vp check` (format and lint; this repo sets `typeCheck: false` in its lint options),
  then `vpr typecheck` for the workspace type check. The same job
  builds the desktop pipeline (`vp run build:desktop`) and verifies the preload bundle exists and
  still exports its expected symbols.
- **Test**: runs non-server workspace tests in parallel and splits the server suite across four
  Linux jobs.
- **Rust**: checks formatting and tests the resource monitor.

`.github/workflows/release.yml` starts after CI passes on a merged `main` pull request. A metadata gate resolves the
version and reuses an existing release. Windows and Linux jobs then build the unsigned Windows x64
installer and Linux x64 AppImage in parallel. The Linux job extracts the AppImage and checks its
payload. After both builds pass, one publish job tags the tested revision and publishes both apps
and their update metadata in one GitHub Release. A final job advances the managed `beta` or
`stable` channel branch. The release matrix publishes Windows x64 and Linux x64 desktop artifacts.

See [Release Checklist](../operations/release.md) for the full release/signing setup checklist.
