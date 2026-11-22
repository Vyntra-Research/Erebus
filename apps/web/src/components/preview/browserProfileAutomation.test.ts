import type { DesktopPreviewBrowserProfile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  browserProfileRemountWebContentsId,
  resolveAutomationBrowserProfile,
} from "./browserProfileAutomation";

const profiles: readonly DesktopPreviewBrowserProfile[] = [
  {
    id: "default",
    name: "Default",
    isDefault: true,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "profile-admin",
    name: "Admin",
    isDefault: false,
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
  },
];

describe("browser profile automation", () => {
  it("accepts only a new webContents instance with the selected profile", () => {
    expect(
      browserProfileRemountWebContentsId({
        expectedProfileId: "profile-admin",
        currentProfileId: "profile-admin",
        previousWebContentsId: 10,
        currentWebContentsId: 11,
      }),
    ).toBe(11);
    expect(
      browserProfileRemountWebContentsId({
        expectedProfileId: "profile-admin",
        currentProfileId: "default",
        previousWebContentsId: 10,
        currentWebContentsId: 11,
      }),
    ).toBeNull();
    expect(
      browserProfileRemountWebContentsId({
        expectedProfileId: "profile-admin",
        currentProfileId: "profile-admin",
        previousWebContentsId: 10,
        currentWebContentsId: 10,
      }),
    ).toBeNull();
  });

  it("resolves a profile by exact id", () => {
    expect(resolveAutomationBrowserProfile(profiles, { profileId: "profile-admin" })).toEqual(
      profiles[1],
    );
  });

  it("resolves a unique profile name without case sensitivity", () => {
    expect(resolveAutomationBrowserProfile(profiles, { profileName: "admin" })).toEqual(
      profiles[1],
    );
  });

  it("rejects a missing profile", () => {
    expect(() => resolveAutomationBrowserProfile(profiles, { profileName: "Member" })).toThrow(
      'Browser session with name "Member" was not found.',
    );
  });

  it("rejects an ambiguous profile name and requires the id", () => {
    const ambiguousProfiles = [
      ...profiles,
      {
        ...profiles[1]!,
        id: "profile-admin-duplicate",
        name: "admin",
      },
    ];

    expect(() =>
      resolveAutomationBrowserProfile(ambiguousProfiles, { profileName: "Admin" }),
    ).toThrow('Browser session name "Admin" is ambiguous; use profileId.');
  });
});
