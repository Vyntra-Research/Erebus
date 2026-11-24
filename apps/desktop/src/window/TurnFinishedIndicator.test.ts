import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import type * as Electron from "electron";

import type * as ElectronWindow from "../electron/ElectronWindow.ts";
import { makeTurnFinishedIndicator } from "./TurnFinishedIndicator.ts";

const electronMock = vi.hoisted(() => ({
  setOverlayIcon: vi.fn(),
  flashFrame: vi.fn(),
  setBadge: vi.fn(),
  bounce: vi.fn(),
  setBadgeCount: vi.fn(),
  createFromDataURL: vi.fn((url: string) => ({ url })),
}));

vi.mock("electron", () => ({
  app: {
    dock: {
      setBadge: electronMock.setBadge,
      bounce: electronMock.bounce,
    },
    setBadgeCount: electronMock.setBadgeCount,
  },
  nativeImage: {
    createFromDataURL: electronMock.createFromDataURL,
  },
}));

function makeWindow(input: { readonly focused: boolean; readonly visible: boolean }) {
  const listeners = new Map<string, () => void>();
  const window = {
    isDestroyed: () => false,
    isVisible: () => input.visible,
    isFocused: () => input.focused,
    setOverlayIcon: electronMock.setOverlayIcon,
    flashFrame: electronMock.flashFrame,
    on: (event: string, listener: () => void) => {
      listeners.set(event, listener);
    },
  } as unknown as Electron.BrowserWindow;
  return { window, listeners };
}

function makeIndicator(window: Electron.BrowserWindow) {
  return makeTurnFinishedIndicator({
    platform: "win32",
    electronWindow: {
      currentMainOrFirst: Effect.succeed(Option.some(window)),
    } as unknown as ElectronWindow.ElectronWindow["Service"],
  });
}

describe("TurnFinishedIndicator", () => {
  it.effect("lights the taskbar until an error is cleared, and never downgrades it", () =>
    Effect.gen(function* () {
      electronMock.setOverlayIcon.mockClear();
      electronMock.flashFrame.mockClear();
      electronMock.createFromDataURL.mockClear();
      const { window } = makeWindow({ focused: false, visible: true });
      const indicator = makeIndicator(window);

      yield* indicator.report("success");
      expect(electronMock.createFromDataURL).toHaveBeenCalledTimes(1);
      expect(electronMock.setOverlayIcon).toHaveBeenCalledTimes(1);
      expect(electronMock.flashFrame).toHaveBeenLastCalledWith(true);

      yield* indicator.report("error");
      expect(electronMock.createFromDataURL).toHaveBeenCalledTimes(2);
      expect(electronMock.setOverlayIcon).toHaveBeenCalledTimes(2);

      yield* indicator.report("success");
      expect(electronMock.setOverlayIcon).toHaveBeenCalledTimes(2);

      yield* indicator.clear;
      expect(electronMock.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
      expect(electronMock.flashFrame).toHaveBeenLastCalledWith(false);
      expect(electronMock.setBadgeCount).not.toHaveBeenCalled();
    }),
  );

  it.effect("does nothing while the user is already looking at the window", () =>
    Effect.gen(function* () {
      electronMock.createFromDataURL.mockClear();
      electronMock.setOverlayIcon.mockClear();
      const { window } = makeWindow({ focused: true, visible: true });

      yield* makeIndicator(window).report("error");

      expect(electronMock.createFromDataURL).not.toHaveBeenCalled();
      expect(electronMock.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
    }),
  );

  it.effect("registers a focus handler and clears the indicator on return", () =>
    Effect.gen(function* () {
      electronMock.setOverlayIcon.mockClear();
      const { window, listeners } = makeWindow({ focused: false, visible: true });
      const indicator = makeIndicator(window);

      yield* indicator.report("success");
      expect(electronMock.setOverlayIcon).toHaveBeenCalledTimes(1);

      const clearOnFocus = listeners.get("focus");
      expect(clearOnFocus).toBeDefined();
      yield* indicator.clear;

      expect(electronMock.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
      expect(electronMock.flashFrame).toHaveBeenLastCalledWith(false);
    }),
  );

  it.effect("keeps the dock badge on macOS and clears it on return", () =>
    Effect.gen(function* () {
      electronMock.setBadge.mockClear();
      electronMock.bounce.mockClear();
      const { window } = makeWindow({ focused: false, visible: true });
      const indicator = makeTurnFinishedIndicator({
        platform: "darwin",
        electronWindow: {
          currentMainOrFirst: Effect.succeed(Option.some(window)),
        } as unknown as ElectronWindow.ElectronWindow["Service"],
      });

      yield* indicator.report("error");
      expect(electronMock.setBadge).toHaveBeenLastCalledWith("!");
      expect(electronMock.bounce).toHaveBeenCalledWith("informational");

      yield* indicator.clear;
      expect(electronMock.setBadge).toHaveBeenLastCalledWith("");
    }),
  );
});
