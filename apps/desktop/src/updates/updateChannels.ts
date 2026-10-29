import type { DesktopUpdateChannel } from "@t3tools/contracts";

const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+(?:\+[0-9A-Za-z.-]+)?$/;
const PRERELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+-[0-9A-Za-z][0-9A-Za-z.-]*(?:\+[0-9A-Za-z.-]+)?$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

export function isBetaDesktopVersion(version: string): boolean {
  return !isNightlyDesktopVersion(version) && PRERELEASE_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  if (isNightlyDesktopVersion(appVersion)) return "nightly";
  return isBetaDesktopVersion(appVersion) ? "beta" : "latest";
}
