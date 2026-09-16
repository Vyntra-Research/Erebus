# Releasing Erebus

Erebus currently ships an unsigned Windows x64 installer and Linux x64 AppImage. The release workflow starts after CI passes on `main`. A maintainer can also start it by hand.

## Before merging

1. Set the desktop, server, web, and contracts packages to the same version.
2. Confirm the managed Proteus version.
3. Run the test suite. Build the Windows installer on Windows and the AppImage on Linux.
4. Check the repository for credentials, local paths, private research data, private notes, unpublished findings, and logs.
5. Confirm both app payloads and their update metadata (`latest.yml` and `latest-linux.yml`).

## Automated release

`.github/workflows/release.yml` uses the version in `apps/desktop/package.json`, unless a maintainer supplies an explicit version in a manual run. It then builds the Windows x64 installer and Linux x64 AppImage from the same tested revision. It extracts and checks the AppImage before a final job creates the matching `v<version>` tag and publishes all files in one GitHub Release. If the release already exists, the workflow exits without replacing it.

A version with a suffix, such as `0.1.4-rc.1`, creates a prerelease. The workflow does not publish npm packages or build macOS or ARM64 desktop apps.

## Upstream history

The `upstream` remote tracks [T3 Code](https://github.com/pingdotgg/t3code) for attribution and base updates. Erebus changes and releases go to `origin`.
