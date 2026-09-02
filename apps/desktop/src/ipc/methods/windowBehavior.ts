import { DesktopWindowBehaviorStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const readState = Effect.fn("desktop.ipc.windowBehavior.readState")(function* () {
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const current = yield* settings.get;
  return { closeToTray: current.closeToTray === true };
});

export const getWindowBehaviorState = makeIpcMethod({
  channel: IpcChannels.GET_WINDOW_BEHAVIOR_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopWindowBehaviorStateSchema,
  handler: readState,
});

export const setCloseToTray = makeIpcMethod({
  channel: IpcChannels.SET_CLOSE_TO_TRAY_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopWindowBehaviorStateSchema,
  handler: Effect.fn("desktop.ipc.windowBehavior.setCloseToTray")(function* (enabled) {
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const setCloseToTrayEnabled = desktopWindow.setCloseToTrayEnabled;
    if (setCloseToTrayEnabled === undefined) {
      return { closeToTray: false };
    }
    yield* setCloseToTrayEnabled(enabled);
    const persist = settings.setCloseToTray;
    if (persist === undefined) {
      return { closeToTray: enabled };
    }
    const result = yield* persist(enabled).pipe(
      Effect.tapError(() => setCloseToTrayEnabled(!enabled).pipe(Effect.ignore)),
    );
    return { closeToTray: result.settings.closeToTray === true };
  }),
});
