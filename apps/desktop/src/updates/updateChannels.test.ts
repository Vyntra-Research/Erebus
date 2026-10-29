import { describe, expect, it } from "vite-plus/test";

import {
  isBetaDesktopVersion,
  isNightlyDesktopVersion,
  resolveDefaultDesktopUpdateChannel,
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
