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

`.github/workflows/release.yml` starts after CI passes on `main`. It builds the unsigned Windows x64
installer, creates the version tag, and publishes the installer and update metadata in one GitHub
Release. Other platform, mobile, relay, hosted preview, and package publication workflows are not
enabled in `0.1.1`.

See [Release Checklist](../operations/release.md) for the full release/signing setup checklist.
