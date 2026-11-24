import { describe, expect, it } from "vite-plus/test";

import {
  compareDesktopVersions,
  isBetaDesktopVersion,
  isDesktopVersionAllowedOnChannel,
  isNightlyDesktopVersion,
  resolveDefaultDesktopUpdateChannel,
  selectNewestDesktopVersion,
} from "./updateChannels.ts";

describe("desktop update channels", () => {
  it("keeps stable releases on latest", () => {
    expect(resolveDefaultDesktopUpdateChannel("0.9.10")).toBe("latest");
    expect(resolveDefaultDesktopUpdateChannel("0.9.10+windows-x64")).toBe("latest");
    expect(isBetaDesktopVersion("0.9.10")).toBe(false);
  });

  it("routes prereleases to beta", () => {
    expect(resolveDefaultDesktopUpdateChannel("1.0.0-beta")).toBe("beta");
    expect(resolveDefaultDesktopUpdateChannel("1.0.0-beta.2")).toBe("beta");
    expect(resolveDefaultDesktopUpdateChannel("1.0.0-rc.1")).toBe("beta");
    expect(isBetaDesktopVersion("1.0.0-beta.2")).toBe(true);
  });

  it("keeps nightly builds on their dedicated channel", () => {
    const version = "1.0.0-nightly.20261029.1";
    expect(isNightlyDesktopVersion(version)).toBe(true);
    expect(isBetaDesktopVersion(version)).toBe(false);
    expect(resolveDefaultDesktopUpdateChannel(version)).toBe("nightly");
    expect(resolveDefaultDesktopUpdateChannel(`${version}+windows-x64`)).toBe("nightly");
  });
});

describe("desktop update channel acceptance", () => {
  it("lets beta install newer stable builds", () => {
    expect(isDesktopVersionAllowedOnChannel("latest", "2.0.0")).toBe(true);
    expect(isDesktopVersionAllowedOnChannel("latest", "2.0.0-beta.9")).toBe(false);
    expect(isDesktopVersionAllowedOnChannel("beta", "2.0.0")).toBe(true);
    expect(isDesktopVersionAllowedOnChannel("beta", "2.0.0-beta.9")).toBe(true);
    expect(isDesktopVersionAllowedOnChannel("beta", "2.0.0-nightly.20261124.1")).toBe(false);
  });

  it("lets nightly install stable, beta, and nightly builds", () => {
    expect(isDesktopVersionAllowedOnChannel("nightly", "2.0.0")).toBe(true);
    expect(isDesktopVersionAllowedOnChannel("nightly", "2.0.0-beta.9")).toBe(true);
    expect(isDesktopVersionAllowedOnChannel("nightly", "2.0.0-nightly.20261124.1")).toBe(true);
    expect(isDesktopVersionAllowedOnChannel("nightly", "not-a-version")).toBe(false);
  });

  it("ranks releases with semver precedence and ignores build metadata", () => {
    expect(compareDesktopVersions("2.0.0", "2.0.0-beta.9")).toBeGreaterThan(0);
    expect(compareDesktopVersions("2.0.0-beta.10", "2.0.0-beta.9")).toBeGreaterThan(0);
    expect(compareDesktopVersions("2.0.0-nightly.20261124.1", "2.0.0-beta.9")).toBeGreaterThan(0);
    expect(compareDesktopVersions("2.0.0+windows-x64", "2.0.0")).toBe(0);
    expect(compareDesktopVersions("2.0.0", "2.0.1")).toBeLessThan(0);
  });

  it("selects the newest release the channel may install", () => {
    expect(
      selectNewestDesktopVersion("beta", ["2.0.0", "2.1.0-beta.1", "2.2.0-nightly.20261124.1"]),
    ).toBe("2.1.0-beta.1");
    expect(
      selectNewestDesktopVersion("nightly", ["2.0.0", "2.1.0-beta.2", "2.2.0-nightly.20261124.1"]),
    ).toBe("2.2.0-nightly.20261124.1");
    expect(selectNewestDesktopVersion("latest", ["1.9.0", "2.0.0-beta.9"])).toBe("1.9.0");
    expect(
      selectNewestDesktopVersion("nightly", ["2.1.0-beta.2", "2.1.0-nightly.20261124.1", "2.1.0"]),
    ).toBe("2.1.0");
  });
});
