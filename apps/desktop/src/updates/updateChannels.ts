import type { DesktopUpdateChannel } from "@t3tools/contracts";

const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+(?:\+[0-9A-Za-z.-]+)?$/;
const PRERELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+-[0-9A-Za-z][0-9A-Za-z.-]*(?:\+[0-9A-Za-z.-]+)?$/;
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

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

interface ParsedDesktopVersion {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[] | null;
}

function parseDesktopVersion(version: string): ParsedDesktopVersion | null {
  const match = VERSION_PATTERN.exec(version);
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? null : match[4].split("."),
  };
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftIsNumeric = /^\d+$/.test(left);
  const rightIsNumeric = /^\d+$/.test(right);
  if (leftIsNumeric && rightIsNumeric) {
    return Number(left) - Number(right);
  }
  if (leftIsNumeric) return -1;
  if (rightIsNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Semver precedence without build metadata. Releases this app publishes always
 * match the release-version grammar, so an unparsable value sorts first.
 */
export function compareDesktopVersions(left: string, right: string): number {
  const parsedLeft = parseDesktopVersion(left);
  const parsedRight = parseDesktopVersion(right);
  if (parsedLeft === null || parsedRight === null) {
    return parsedLeft === parsedRight ? 0 : parsedLeft === null ? -1 : 1;
  }

  for (let index = 0; index < 3; index += 1) {
    const difference = parsedLeft.core[index]! - parsedRight.core[index]!;
    if (difference !== 0) return difference;
  }

  if (parsedLeft.prerelease === null || parsedRight.prerelease === null) {
    // A release outranks any prerelease of the same core version.
    return parsedLeft.prerelease === parsedRight.prerelease
      ? 0
      : parsedLeft.prerelease === null
        ? 1
        : -1;
  }

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = parsedLeft.prerelease[index];
    const right = parsedRight.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const difference = comparePrereleaseIdentifiers(left, right);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * A channel receives its own releases plus everything more stable than it:
 * stable gets stable, beta gets stable and beta, nightly gets everything.
 */
export function isDesktopVersionAllowedOnChannel(
  channel: DesktopUpdateChannel,
  version: string,
): boolean {
  const parsed = parseDesktopVersion(version);
  if (parsed === null) return false;
  switch (channel) {
    case "latest":
      return parsed.prerelease === null;
    case "beta":
      return !isNightlyDesktopVersion(version);
    case "nightly":
      return true;
  }
}

/** Newest version the channel may install; ties keep the first candidate. */
export function selectNewestDesktopVersion(
  channel: DesktopUpdateChannel,
  versions: ReadonlyArray<string>,
): string | null {
  let newest: string | null = null;
  for (const version of versions) {
    if (!isDesktopVersionAllowedOnChannel(channel, version)) continue;
    if (newest === null || compareDesktopVersions(version, newest) > 0) {
      newest = version;
    }
  }
  return newest;
}

export function stripReleaseTagPrefix(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}
