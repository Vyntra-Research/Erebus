import { MicroVmError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerConfig from "../../../config.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, ServerConfig.ServerConfig];
const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema);

const Name = Schema.String.annotate({
  description: "MicroVM name returned by microvm_create or microvm_list.",
});
const X = Schema.Number.annotate({
  description: "X pixel in the most recent microvm_observe screenshot.",
});
const Y = Schema.Number.annotate({
  description: "Y pixel in the most recent microvm_observe screenshot.",
});

export const MicroVmWindow = Schema.Struct({
  id: Schema.String,
  desktop: Schema.String,
  title: Schema.String,
  active: Schema.Boolean,
});
export type MicroVmWindow = typeof MicroVmWindow.Type;

export const MicroVmScreenshot = Schema.Struct({
  mimeType: Schema.String,
  data: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  scaleX: Schema.Number,
  scaleY: Schema.Number,
});
export type MicroVmScreenshot = typeof MicroVmScreenshot.Type;

export const MicroVmObservation = Schema.Struct({
  name: Schema.String,
  screenshot: MicroVmScreenshot,
  windows: Schema.Array(MicroVmWindow),
  activeWindowId: Schema.NullOr(Schema.Int),
  capturedAt: Schema.String,
});
export type MicroVmObservation = typeof MicroVmObservation.Type;

export const MicroVmActionResult = Schema.Struct({ ok: Schema.Boolean });
export type MicroVmActionResult = typeof MicroVmActionResult.Type;

export const MicroVmObserveTool = Tool.make("microvm_observe", {
  description:
    "Observe the whole graphical desktop of a desktop microVM. Starts the guest and desktop services when needed, captures the full display as a PNG, and returns the open windows and active window id. Coordinates used by microvm_click, microvm_scroll, and microvm_drag are pixels in this most recent screenshot. Re-observe after every action that can change the screen. Call microvm_desktop open once to watch the same desktop live in the preview pane.",
  parameters: Schema.Struct({ name: Name }),
  success: MicroVmObservation,
  failure: MicroVmError,
  dependencies,
})
  .annotate(Tool.Title, "Observe a microVM desktop")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const MicroVmClickTool = Tool.make("microvm_click", {
  description:
    "Click a pixel in the desktop of a microVM. Use coordinates from the most recent microvm_observe screenshot. The action targets the guest display, not the host, and never moves the host pointer.",
  parameters: Schema.Struct({
    name: Name,
    x: X,
    y: Y,
    button: optional(
      Schema.Literals(["left", "right", "middle"]).annotate({
        description: "Mouse button. Defaults to left.",
      }),
    ),
    clickCount: optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
        .check(Schema.isLessThanOrEqualTo(3))
        .annotate({ description: "Click count, 1 to 3. Defaults to 1." }),
    ),
  }),
  success: MicroVmActionResult,
  failure: MicroVmError,
  dependencies,
})
  .annotate(Tool.Title, "Click in a microVM desktop")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const MicroVmTypeTextTool = Tool.make("microvm_type_text", {
  description:
    "Type literal text into the focused guest window of a microVM. Click the intended field first with microvm_click. Newlines are supported by pressing Return between lines.",
  parameters: Schema.Struct({
    name: Name,
    text: Schema.String.annotate({ description: "Literal text to type." }),
  }),
  success: MicroVmActionResult,
  failure: MicroVmError,
  dependencies,
})
  .annotate(Tool.Title, "Type text in a microVM desktop")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const MicroVmPressKeyTool = Tool.make("microvm_press_key", {
  description:
    "Press a key or key chord in the focused guest window of a microVM using X11 names: a, space, Return, Tab, Escape, F5, Control_L+a, Control_L+Shift_L+period, KP_0.",
  parameters: Schema.Struct({
    name: Name,
    key: Schema.String.annotate({ description: "Key or +-separated chord." }),
  }),
  success: MicroVmActionResult,
  failure: MicroVmError,
  dependencies,
})
  .annotate(Tool.Title, "Press a key in a microVM desktop")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const MicroVmScrollTool = Tool.make("microvm_scroll", {
  description:
    "Scroll inside the guest desktop at a screenshot coordinate, or at the current pointer when coordinates are omitted. Negative scrollY means up and positive means down; negative scrollX means left and positive means right.",
  parameters: Schema.Struct({
    name: Name,
    x: optional(X),
    y: optional(Y),
    scrollX: Schema.Int.annotate({ description: "Horizontal scroll delta." }),
    scrollY: Schema.Int.annotate({ description: "Vertical scroll delta." }),
  }),
  success: MicroVmActionResult,
  failure: MicroVmError,
  dependencies,
})
  .annotate(Tool.Title, "Scroll in a microVM desktop")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const MicroVmDragTool = Tool.make("microvm_drag", {
  description:
    "Drag between two screenshot coordinates in a microVM desktop. Observe first; both points should come from the same latest observation.",
  parameters: Schema.Struct({
    name: Name,
    fromX: X,
    fromY: Y,
    toX: X,
    toY: Y,
  }),
  success: MicroVmActionResult,
  failure: MicroVmError,
  dependencies,
})
  .annotate(Tool.Title, "Drag in a microVM desktop")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const MicroVmListWindowsTool = Tool.make("microvm_list_windows", {
  description:
    "List the open windows of a desktop microVM with their window id, desktop, title, and active state. Activate one with microvm_activate_window.",
  parameters: Schema.Struct({ name: Name }),
  success: Schema.Struct({
    windows: Schema.Array(MicroVmWindow),
    activeWindowId: Schema.NullOr(Schema.Int),
  }),
  failure: MicroVmError,
  dependencies,
})
  .annotate(Tool.Title, "List microVM windows")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const MicroVmActivateWindowTool = Tool.make("microvm_activate_window", {
  description:
    "Bring an open guest window of a desktop microVM to the foreground using the exact id returned by microvm_list_windows.",
  parameters: Schema.Struct({
    name: Name,
    id: Schema.String.annotate({ description: "Exact window id from microvm_list_windows." }),
  }),
  success: MicroVmActionResult,
  failure: MicroVmError,
  dependencies,
})
  .annotate(Tool.Title, "Activate a microVM window")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const MicroVmLaunchAppTool = Tool.make("microvm_launch_app", {
  description:
    "Launch a program inside a desktop microVM. Pass a command available in the guest such as chromium, qterminal, thunar, or gtk-launch with a desktop entry. The guest runs it under the desktop display; observe with microvm_observe afterwards.",
  parameters: Schema.Struct({
    name: Name,
    command: Schema.String.annotate({
      description: "Guest command line, for example chromium or qterminal.",
    }),
  }),
  success: MicroVmActionResult,
  failure: MicroVmError,
  dependencies,
})
  .annotate(Tool.Title, "Launch a microVM app")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const MicroVmComputerToolkit = Toolkit.make(
  MicroVmObserveTool,
  MicroVmClickTool,
  MicroVmTypeTextTool,
  MicroVmPressKeyTool,
  MicroVmScrollTool,
  MicroVmDragTool,
  MicroVmListWindowsTool,
  MicroVmActivateWindowTool,
  MicroVmLaunchAppTool,
);
