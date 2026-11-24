import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Electron from "electron";

import type * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  mergeTurnFinishedOutcome,
  TURN_FINISHED_OVERLAY_DATA_URLS,
  turnFinishedDockBadge,
  turnFinishedOverlayDescription,
  type TurnFinishedOutcome,
} from "./turnFinishedIndicator.logic.ts";

export interface TurnFinishedIndicator {
  readonly report: (outcome: TurnFinishedOutcome) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
}

export type { TurnFinishedOutcome } from "./turnFinishedIndicator.logic.ts";

/**
 * Owns the "a chat turn finished" affordance outside the renderer: a Windows
 * overlay icon, a macOS dock badge, and a taskbar flash until the user returns
 * to the window. The renderer reports every terminal turn; this decides whether
 * the user is already looking and keeps the strongest unread outcome.
 */
export function makeTurnFinishedIndicator(input: {
  readonly platform: NodeJS.Platform;
  readonly electronWindow: ElectronWindow.ElectronWindow["Service"];
}): TurnFinishedIndicator {
  let currentOutcome: TurnFinishedOutcome | null = null;
  const observedWindows = new WeakSet<Electron.BrowserWindow>();

  const clearPlatformIndicator = () => {
    if (input.platform === "darwin") {
      Electron.app.dock?.setBadge("");
    } else if (input.platform === "linux") {
      Electron.app.setBadgeCount(0);
    }
  };

  const clearWindowIndicator = (window: Electron.BrowserWindow) => {
    if (window.isDestroyed()) return;
    if (input.platform === "win32") {
      window.setOverlayIcon(null, "");
    }
    window.flashFrame(false);
  };

  const clear = Effect.flatMap(input.electronWindow.currentMainOrFirst, (window) =>
    Effect.sync(() => {
      currentOutcome = null;
      if (Option.isSome(window)) {
        clearWindowIndicator(window.value);
      }
      clearPlatformIndicator();
    }),
  );

  const observeWindow = (window: Electron.BrowserWindow) => {
    if (observedWindows.has(window)) return;
    observedWindows.add(window);
    const clearAfterReturn = () => {
      void Effect.runPromise(clear).catch(() => undefined);
    };
    window.on("focus", clearAfterReturn);
    window.on("closed", clearAfterReturn);
  };

  const applyWindowIndicator = (window: Electron.BrowserWindow, outcome: TurnFinishedOutcome) => {
    if (window.isDestroyed()) return;
    if (input.platform === "win32") {
      window.setOverlayIcon(
        Electron.nativeImage.createFromDataURL(TURN_FINISHED_OVERLAY_DATA_URLS[outcome]),
        turnFinishedOverlayDescription(outcome),
      );
    }
    if (input.platform !== "darwin") {
      window.flashFrame(true);
    }
  };

  const applyPlatformIndicator = (outcome: TurnFinishedOutcome) => {
    if (input.platform === "darwin") {
      Electron.app.dock?.setBadge(turnFinishedDockBadge(outcome));
      Electron.app.dock?.bounce("informational");
    } else if (input.platform === "linux") {
      Electron.app.setBadgeCount(1);
    }
  };

  return {
    report: (outcome) =>
      Effect.flatMap(input.electronWindow.currentMainOrFirst, (window) =>
        Effect.sync(() => {
          if (Option.isNone(window) || window.value.isDestroyed()) {
            currentOutcome = null;
            return;
          }
          if (window.value.isVisible() && window.value.isFocused()) {
            currentOutcome = null;
            clearWindowIndicator(window.value);
            clearPlatformIndicator();
            return;
          }

          const nextOutcome = mergeTurnFinishedOutcome(currentOutcome, outcome);
          if (nextOutcome === currentOutcome) return;
          currentOutcome = nextOutcome;
          observeWindow(window.value);
          applyWindowIndicator(window.value, nextOutcome);
          applyPlatformIndicator(nextOutcome);
        }),
      ),
    clear,
  };
}
