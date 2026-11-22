import type { DesktopPreviewBrowserProfile } from "@t3tools/contracts";

export interface BrowserProfileSelector {
  readonly profileId?: string;
  readonly profileName?: string;
}

export function browserProfileRemountWebContentsId(input: {
  readonly expectedProfileId: string;
  readonly currentProfileId: string | null;
  readonly previousWebContentsId: number | null;
  readonly currentWebContentsId: number | null;
}): number | null {
  if (
    input.currentProfileId !== input.expectedProfileId ||
    input.currentWebContentsId === null ||
    input.currentWebContentsId === input.previousWebContentsId
  ) {
    return null;
  }
  return input.currentWebContentsId;
}

export function resolveAutomationBrowserProfile(
  profiles: readonly DesktopPreviewBrowserProfile[],
  selector: BrowserProfileSelector,
): DesktopPreviewBrowserProfile {
  if (selector.profileId !== undefined) {
    const profile = profiles.find((candidate) => candidate.id === selector.profileId);
    if (profile) return profile;
    throw new Error(`Browser session with id ${JSON.stringify(selector.profileId)} was not found.`);
  }

  const profileName = selector.profileName ?? "";
  const matches = profiles.filter(
    (candidate) =>
      candidate.name.localeCompare(profileName, undefined, {
        sensitivity: "accent",
      }) === 0,
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `Browser session name ${JSON.stringify(selector.profileName)} is ambiguous; use profileId.`,
    );
  }
  const description = `name ${JSON.stringify(selector.profileName)}`;
  throw new Error(`Browser session with ${description} was not found.`);
}
