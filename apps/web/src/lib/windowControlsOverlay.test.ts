import { describe, expect, it } from "vite-plus/test";

import { getElectronPlatformClassNames } from "./windowControlsOverlay";

describe("getElectronPlatformClassNames", () => {
  it("enables translucent desktop surfaces on Windows", () => {
    expect(getElectronPlatformClassNames("Win32")).toEqual([
      "electron",
      "electron-windows",
      "electron-translucent",
    ]);
  });

  it("enables translucent desktop surfaces on Linux", () => {
    expect(getElectronPlatformClassNames("Linux x86_64")).toEqual([
      "electron",
      "electron-translucent",
    ]);
  });

  it("keeps macOS on its native opaque surface", () => {
    expect(getElectronPlatformClassNames("MacIntel")).toEqual(["electron"]);
  });
});
