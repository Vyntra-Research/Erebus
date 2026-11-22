# Releasing Erebus

Erebus currently ships an unsigned Windows x64 installer and Linux x64 AppImage. The release workflow starts after CI passes on `main`. A maintainer can also start it by hand.

## Branch roles

- `main` contains the newest integrated code. All feature, fix, and release pull requests target it.
- `beta` points to the commit used by the latest beta release.
- `stable` points to the commit used by the latest stable release.

Do not merge changes into `beta` or `stable`. The release workflow advances those branches only after the matching GitHub Release exists. It rejects commits outside `main` and refuses to move a channel branch backward or across unrelated history.

## Before merging

1. Set the desktop, server, web, and contracts packages to the same version.
2. Run the test suite. Build the Windows installer on Windows and the AppImage on Linux.
3. Check the repository for credentials, local paths, private research data, private notes, unpublished findings, and logs.
4. Confirm both app payloads and their update metadata (`latest.yml` and `latest-linux.yml`).

## Automated release

`.github/workflows/release.yml` uses the version in `apps/desktop/package.json`, unless a maintainer supplies an explicit version in a manual run. Manual runs must use a `main` commit with successful CI. The workflow then builds the Windows x64 installer and Linux x64 AppImage from the same tested revision. It extracts and checks the AppImage before a final job creates the matching `v<version>` tag and publishes all files in one GitHub Release. If the release already exists, the workflow keeps it and repairs the matching channel pointer when needed.

A version with a suffix, such as `2.0.0-beta.1`, publishes a prerelease through `beta.yml` and advances `beta`. A full version publishes through `latest.yml` and advances `stable`. Nightly versions use their own update manifest. The release matrix builds Windows x64 and Linux x64 desktop apps.

## Upstream history

The `upstream` remote tracks [T3 Code](https://github.com/pingdotgg/t3code) for attribution and base updates. Erebus changes and releases go to `origin`.
