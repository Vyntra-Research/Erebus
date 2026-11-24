import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerConfig from "../../../config.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, ServerConfig.ServerConfig];
const JsonResult = Schema.Record(Schema.String, Schema.Unknown);

const WindowId = Schema.Int.annotate({
  description: "Exact window id returned by computer_list_windows or computer_list_apps.",
});

const ElementIndex = Schema.Int.annotate({
  description:
    "Element index from the latest computer_get_window_state observation with includeText=true.",
});

const ScreenshotX = Schema.Number.annotate({
  description:
    "X pixel in the most recent screenshot returned by computer_get_window_state for this window.",
});

const ScreenshotY = Schema.Number.annotate({
  description:
    "Y pixel in the most recent screenshot returned by computer_get_window_state for this window.",
});

export const ComputerWindowSchema = Schema.Struct({
  id: Schema.Int,
  app: Schema.String,
  displayName: Schema.String,
  title: Schema.String,
  isForeground: Schema.Boolean,
});

export const ComputerScreenshotSchema = Schema.Struct({
  mimeType: Schema.String,
  data: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  scaleX: Schema.Number,
  scaleY: Schema.Number,
});

export const ComputerAccessibilitySchema = Schema.Struct({
  tree: Schema.String,
  focusedElement: Schema.NullOr(Schema.String),
});

export const ComputerSnapshotResult = Schema.Struct({
  window: ComputerWindowSchema,
  screenshot: Schema.NullOr(ComputerScreenshotSchema),
  accessibility: Schema.NullOr(ComputerAccessibilitySchema),
});
export type ComputerSnapshotResult = typeof ComputerSnapshotResult.Type;

export const ComputerSnapshotTool = Tool.make("computer_get_window_state", {
  description:
    "Observe one window before acting. Returns a bounded screenshot of the window and, with includeText=true, an accessibility tree whose bracketed indexes address elements. Element indexes and screenshot coordinates are valid only for this observation; re-observe after every action that can change the UI. Prefer includeText=true and elementIndex over raw coordinates when the window exposes accessibility. Screenshots are window-relative and work while the window is occluded.",
  parameters: Schema.Struct({
    windowId: WindowId,
    includeScreenshot: Schema.optionalKey(Schema.Boolean).annotate({
      description: "Capture a screenshot. Defaults to true.",
    }),
    includeText: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        "Collect the indexed UI Automation tree. Defaults to false; set true when you need elementIndex actions or a text view of the UI.",
    }),
  }),
  success: ComputerSnapshotResult,
  failure: Schema.String,
  dependencies,
})
  .annotate(Tool.Title, "Observe a desktop window")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ComputerListAppsTool = Tool.make("computer_list_apps", {
  description:
    "List running desktop applications and their targetable windows, grouped by executable. Start here, then keep the exact returned window id. Never invent or reconstruct a window id.",
  parameters: Schema.Struct({}),
  success: JsonResult,
  failure: Schema.String,
  dependencies,
})
  .annotate(Tool.Title, "List desktop apps")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerListWindowsTool = Tool.make("computer_list_windows", {
  description:
    "List open targetable windows with their window id, app, title, and foreground state. Use computer_list_apps when you need grouping by application.",
  parameters: Schema.Struct({}),
  success: JsonResult,
  failure: Schema.String,
  dependencies,
})
  .annotate(Tool.Title, "List desktop windows")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerLaunchAppTool = Tool.make("computer_launch_app", {
  description:
    "Launch a desktop app by executable path, command name, or packaged app id such as Microsoft.WindowsCalculator_8wekyb3d8bbwe!App. The window is not returned directly; call computer_list_windows afterwards and choose the exact window.",
  parameters: Schema.Struct({
    app: Schema.String.annotate({
      description: "Executable path, command name, or packaged app id.",
    }),
  }),
  success: JsonResult,
  failure: Schema.String,
  dependencies,
})
  .annotate(Tool.Title, "Launch a desktop app")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerActivateWindowTool = Tool.make("computer_activate_window", {
  description:
    "Bring an open window to the foreground. Input actions already activate their target window; use this only when you need to focus the window without acting.",
  parameters: Schema.Struct({ windowId: WindowId }),
  success: JsonResult,
  failure: Schema.String,
  dependencies,
})
  .annotate(Tool.Title, "Activate a window")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerClickTool = Tool.make("computer_click", {
  description:
    "Click an indexed element or a screenshot coordinate in the target window. Observe first, then perform exactly one action. elementIndex requires the latest observation with includeText=true. Coordinates are pixels in the latest screenshot for that window. Do not perform destructive, financial, or externally visible actions unless the user explicitly asked for them.",
  parameters: Schema.Struct({
    windowId: WindowId,
    elementIndex: Schema.optionalKey(ElementIndex),
    x: Schema.optionalKey(ScreenshotX),
    y: Schema.optionalKey(ScreenshotY),
    mouseButton: Schema.optionalKey(
      Schema.Literals(["left", "right", "middle"]).annotate({
        description: "Mouse button. Defaults to left.",
      }),
    ),
    clickCount: Schema.optionalKey(
      Schema.Int.annotate({ description: "Click count, 1 to 3. Defaults to 1." }),
    ),
  }),
  success: JsonResult,
  failure: Schema.String,
  dependencies,
})
  .annotate(Tool.Title, "Click in a window")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerTypeTextTool = Tool.make("computer_type_text", {
  description:
    "Type text into the focused control of the target window using native keyboard input. Click the intended field first. Newlines and tabs are supported. Typing sensitive data or submitting it counts as transmission; only do that with explicit user intent.",
  parameters: Schema.Struct({
    windowId: WindowId,
    text: Schema.String.annotate({ description: "Literal text to type." }),
  }),
  success: JsonResult,
  failure: Schema.String,
  dependencies,
})
  .annotate(Tool.Title, "Type text into a window")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerPressKeyTool = Tool.make("computer_press_key", {
  description:
    "Press a key or key chord in the target window, using X11-style names: a, space, Return, Tab, Escape, F5, Control_L+a, Control_L+Shift_L+period, KP_0. Whitespace around + is ignored.",
  parameters: Schema.Struct({
    windowId: WindowId,
    key: Schema.String.annotate({ description: "Key or +-separated chord." }),
  }),
  success: JsonResult,
  failure: Schema.String,
  dependencies,
})
  .annotate(Tool.Title, "Press a key")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerScrollTool = Tool.make("computer_scroll", {
  description:
    "Scroll inside the target window at a screenshot coordinate, or at the window center when coordinates are omitted. Negative scrollY means up and positive means down; negative scrollX means left and positive means right.",
  parameters: Schema.Struct({
    windowId: WindowId,
    x: Schema.optionalKey(ScreenshotX),
    y: Schema.optionalKey(ScreenshotY),
    scrollX: Schema.Int.annotate({ description: "Horizontal scroll delta." }),
    scrollY: Schema.Int.annotate({ description: "Vertical scroll delta." }),
  }),
  success: JsonResult,
  failure: Schema.String,
  dependencies,
})
  .annotate(Tool.Title, "Scroll a window")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerSetValueTool = Tool.make("computer_set_value", {
  description:
    "Replace the value of an indexed editable element through UI Automation. This is more reliable than typing when the element exposes a value pattern; re-observe afterwards.",
  parameters: Schema.Struct({
    windowId: WindowId,
    elementIndex: ElementIndex,
    value: Schema.String.annotate({ description: "Replacement value." }),
  }),
  success: JsonResult,
  failure: Schema.String,
  dependencies,
})
  .annotate(Tool.Title, "Set an element value")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ComputerDragTool = Tool.make("computer_drag", {
  description:
    "Drag between two screenshot coordinates in the target window. Observe first; both points must come from the same latest observation.",
  parameters: Schema.Struct({
    windowId: WindowId,
    fromX: ScreenshotX,
    fromY: ScreenshotY,
    toX: ScreenshotX,
    toY: ScreenshotY,
  }),
  success: JsonResult,
  failure: Schema.String,
  dependencies,
})
  .annotate(Tool.Title, "Drag in a window")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerSecondaryActionTool = Tool.make("computer_secondary_action", {
  description:
    "Invoke a UI Automation secondary action on an indexed element: invoke, toggle, expand, collapse, select, focus, or scroll up/down/left/right. Use when a plain click is not the correct interaction.",
  parameters: Schema.Struct({
    windowId: WindowId,
    elementIndex: ElementIndex,
    action: Schema.String.annotate({ description: "Secondary action label." }),
  }),
  success: JsonResult,
  failure: Schema.String,
  dependencies,
})
  .annotate(Tool.Title, "Invoke a secondary action")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ComputerStandardToolkit = Toolkit.make(
  ComputerListAppsTool,
  ComputerListWindowsTool,
  ComputerLaunchAppTool,
  ComputerActivateWindowTool,
  ComputerClickTool,
  ComputerTypeTextTool,
  ComputerPressKeyTool,
  ComputerScrollTool,
  ComputerSetValueTool,
  ComputerDragTool,
  ComputerSecondaryActionTool,
);

export const ComputerSnapshotToolkit = Toolkit.make(ComputerSnapshotTool);
