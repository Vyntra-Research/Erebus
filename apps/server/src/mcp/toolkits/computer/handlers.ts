import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerConfig from "../../../config.ts";
import {
  requestComputerUse,
  setComputerUseBinaryPath,
} from "../../../computerUse/ComputerUseClient.ts";
import {
  ComputerSnapshotToolkit,
  ComputerStandardToolkit,
  type ComputerSnapshotResult,
} from "./tools.ts";

const invoke = <A>(method: string, params?: unknown) =>
  Effect.gen(function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    if (!invocation.capabilities.has("computer")) {
      return yield* Effect.fail("Computer Use is not enabled for this agent session.");
    }
    const config = yield* ServerConfig.ServerConfig;
    yield* Effect.sync(() => setComputerUseBinaryPath(config.computerUsePath));
    return yield* Effect.tryPromise({
      try: () => requestComputerUse<A>(method, params),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    });
  });

const handlers = {
  computer_list_apps: () => invoke("list_apps"),
  computer_list_windows: () => invoke("list_windows"),
  computer_launch_app: (input) => invoke("launch_app", input),
  computer_activate_window: (input) => invoke("activate_window", input),
  computer_click: (input) => invoke("click", input),
  computer_type_text: (input) => invoke("type_text", input),
  computer_press_key: (input) => invoke("press_key", input),
  computer_scroll: (input) => invoke("scroll", input),
  computer_set_value: (input) => invoke("set_value", input),
  computer_drag: (input) => invoke("drag", input),
  computer_secondary_action: (input) => invoke("secondary_action", input),
} satisfies Parameters<typeof ComputerStandardToolkit.toLayer>[0];

export const ComputerStandardToolkitHandlersLive = ComputerStandardToolkit.toLayer(handlers);

export const ComputerSnapshotToolkitHandlersLive = ComputerSnapshotToolkit.toLayer({
  computer_get_window_state: (input) => invoke<ComputerSnapshotResult>("get_window_state", input),
});
