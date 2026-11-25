import { MicroVmError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerConfig from "../../../config.ts";
import * as MicroVmRuntime from "../../../microVm/MicroVmRuntime.ts";
import { MicroVmComputerToolkit, MicroVmScreenshot, MicroVmWindow } from "./computerTools.ts";

const AgentObservation = Schema.Struct({
  screenshot: MicroVmScreenshot,
  windows: Schema.Array(MicroVmWindow),
  activeWindowId: Schema.NullOr(Schema.Int),
});
const decodeObservation = Schema.decodeUnknownEffect(AgentObservation);
const AgentWindows = Schema.Struct({
  windows: Schema.Array(MicroVmWindow),
  activeWindowId: Schema.NullOr(Schema.Int),
});
const decodeWindows = Schema.decodeUnknownEffect(AgentWindows);

const runtimeForComputer = Effect.fn("MicroVmComputerToolkit.runtime")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("computer")) {
    return yield* new MicroVmError({
      operation: "computer",
      detail: "Computer Use is not enabled for this agent session.",
    });
  }
  const config = yield* ServerConfig.ServerConfig;
  return yield* MicroVmRuntime.make(config.stateDir);
});

const sendInput = (name: string, body: Record<string, unknown>) =>
  Effect.gen(function* () {
    const runtime = yield* runtimeForComputer();
    yield* runtime.ensureDesktop(name);
    yield* runtime.desktopAgentRequest(name, "/input", body);
    return { ok: true };
  });

const handlers = {
  microvm_observe: Effect.fn("MicroVmComputerToolkit.observe")(function* (input: { name: string }) {
    const runtime = yield* runtimeForComputer();
    const info = yield* runtime.ensureDesktop(input.name);
    const raw = yield* runtime.desktopAgentRequest(input.name, "/observe");
    const observation = yield* decodeObservation(raw).pipe(
      Effect.mapError(
        (cause) =>
          new MicroVmError({
            operation: "observe",
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );
    const capturedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    return {
      name: info.name,
      ...observation,
      capturedAt,
    };
  }),
  microvm_click: Effect.fn("MicroVmComputerToolkit.click")(function* (input: {
    name: string;
    x: number;
    y: number;
    button?: "left" | "right" | "middle" | undefined;
    clickCount?: number | undefined;
  }) {
    return yield* sendInput(input.name, {
      action: "click",
      x: input.x,
      y: input.y,
      button: input.button ?? "left",
      count: input.clickCount ?? 1,
    });
  }),
  microvm_type_text: Effect.fn("MicroVmComputerToolkit.typeText")(function* (input: {
    name: string;
    text: string;
  }) {
    return yield* sendInput(input.name, { action: "type", text: input.text });
  }),
  microvm_press_key: Effect.fn("MicroVmComputerToolkit.pressKey")(function* (input: {
    name: string;
    key: string;
  }) {
    return yield* sendInput(input.name, { action: "key", key: input.key });
  }),
  microvm_scroll: Effect.fn("MicroVmComputerToolkit.scroll")(function* (input: {
    name: string;
    x?: number | undefined;
    y?: number | undefined;
    scrollX: number;
    scrollY: number;
  }) {
    return yield* sendInput(input.name, {
      action: "scroll",
      ...(input.x === undefined ? {} : { x: input.x }),
      ...(input.y === undefined ? {} : { y: input.y }),
      scrollX: input.scrollX,
      scrollY: input.scrollY,
    });
  }),
  microvm_drag: Effect.fn("MicroVmComputerToolkit.drag")(function* (input: {
    name: string;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
  }) {
    return yield* sendInput(input.name, {
      action: "drag",
      fromX: input.fromX,
      fromY: input.fromY,
      toX: input.toX,
      toY: input.toY,
    });
  }),
  microvm_list_windows: Effect.fn("MicroVmComputerToolkit.listWindows")(function* (input: {
    name: string;
  }) {
    const runtime = yield* runtimeForComputer();
    yield* runtime.ensureDesktop(input.name);
    const raw = yield* runtime.desktopAgentRequest(input.name, "/windows");
    return yield* decodeWindows(raw).pipe(
      Effect.mapError(
        (cause) =>
          new MicroVmError({
            operation: "windows",
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );
  }),
  microvm_activate_window: Effect.fn("MicroVmComputerToolkit.activateWindow")(function* (input: {
    name: string;
    id: string;
  }) {
    const runtime = yield* runtimeForComputer();
    yield* runtime.ensureDesktop(input.name);
    yield* runtime.desktopAgentRequest(input.name, "/activate", { id: input.id });
    return { ok: true };
  }),
  microvm_launch_app: Effect.fn("MicroVmComputerToolkit.launchApp")(function* (input: {
    name: string;
    command: string;
  }) {
    const runtime = yield* runtimeForComputer();
    yield* runtime.ensureDesktop(input.name);
    yield* runtime.desktopAgentRequest(input.name, "/launch", { command: input.command });
    return { ok: true };
  }),
} satisfies Parameters<typeof MicroVmComputerToolkit.toLayer>[0];

export const MicroVmComputerToolkitHandlersLive = MicroVmComputerToolkit.toLayer(handlers);
