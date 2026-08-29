# Releasing Erebus

Erebus currently ships an unsigned Windows x64 installer. The release workflow starts after CI passes on `main`. A maintainer can also start it by hand.

## Before merging

1. Set the desktop, server, web, and contracts packages to the same version.
2. Confirm the managed Proteus version.
3. Run the test suite and build the Windows installer.
4. Check the repository for credentials, local paths, campaign data, private notes, unpublished findings, and logs.
5. Confirm the installer contents and update metadata.

## Automated release

`.github/workflows/release.yml` checks the version in `apps/desktop/package.json`, builds the Windows x64 installer, creates the matching `v<version>` tag, and publishes the files in a GitHub Release. If the release already exists, the job exits without replacing it.

A version with a suffix, such as `0.1.4-rc.1`, creates a prerelease. The workflow does not publish npm packages or build other platforms.

## Upstream history

The `upstream` remote tracks [T3 Code](https://github.com/pingdotgg/t3code) for attribution and base updates. Erebus changes and releases go to `origin`.
