// @effect-diagnostics nodeBuiltinImport:off - the desktop probe is a loopback health check.
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ServerConfig from "../../../config.ts";
import * as MicroVmRuntime from "../../../microVm/MicroVmRuntime.ts";
import { MicroVmError } from "@t3tools/contracts";
import type { PreviewAutomationStatus } from "@t3tools/contracts";
import {
  MicroVmToolkit,
  type MicroVmCopyInput,
  type MicroVmDesktopActionInput,
  type MicroVmExecInput,
  type MicroVmJobInput,
} from "./tools.ts";

const probeDesktop = (
  viewerUrl: string,
): Promise<{ readonly ready: boolean; readonly statusCode: number | null }> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (result: { readonly ready: boolean; readonly statusCode: number | null }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = NodeHttp.get(viewerUrl, { timeout: 5_000 }, (response) => {
      response.resume();
      const statusCode = response.statusCode ?? null;
      finish({
        ready: statusCode !== null && statusCode >= 200 && statusCode < 400,
        statusCode,
      });
    });
    request.once("timeout", () => {
      request.destroy();
      finish({ ready: false, statusCode: null });
    });
    request.once("error", () => finish({ ready: false, statusCode: null }));
  });

const handlers = {
  microvm_list: Effect.fn("MicroVmToolkit.list")(function* () {
    yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    return { sandboxes: yield* runtime.list(), home: runtime.home };
  }),
  microvm_create: Effect.fn("MicroVmToolkit.create")(function* (input) {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    return yield* runtime.create({
      ...input,
      threadId: input.threadId ?? invocation.threadId,
    });
  }),
  microvm_control: Effect.fn("MicroVmToolkit.control")(function* (input) {
    yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    return yield* runtime.control(input);
  }),
  microvm_modify: Effect.fn("MicroVmToolkit.modify")(function* (input) {
    yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    return yield* runtime.modify(input);
  }),
  microvm_exec: Effect.fn("MicroVmToolkit.exec")(function* (input: MicroVmExecInput) {
    yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    return yield* runtime.exec({ ...input, args: input.args ?? [] });
  }),
  microvm_job: Effect.fn("MicroVmToolkit.job")(function* (input: MicroVmJobInput) {
    yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    if (input.action === "list") return yield* runtime.jobs(input.name);
    if (input.action === "stop") {
      yield* runtime.stopJob(input.name, input.jobId);
      return { stopped: true, jobId: input.jobId };
    }
    const entries = yield* runtime.jobLogs(input.name, input.jobId, input.tail);
    return {
      jobId: input.jobId,
      entries: entries.map((entry) => ({
        timestamp: entry.timestamp,
        source: entry.source,
        data: entry.data.toString("utf8"),
        cursor: entry.cursor,
      })),
    };
  }),
  microvm_copy: Effect.fn("MicroVmToolkit.copy")(function* (input: MicroVmCopyInput) {
    yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    const copy = { name: input.name, source: input.source, destination: input.destination };
    if (input.direction === "in") yield* runtime.copyIn(copy);
    else yield* runtime.copyOut(copy);
    return { copied: true };
  }),
  microvm_desktop: Effect.fn("MicroVmToolkit.desktop")(function* (
    input: MicroVmDesktopActionInput,
  ) {
    yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    let info = yield* runtime.get(input.name);
    if (info.desktop === null) {
      return yield* new MicroVmError({
        operation: "desktop",
        detail: `${info.name} was not created with a desktop profile.`,
      });
    }
    if (input.action === "restart") {
      info = yield* runtime.control({ name: input.name, action: "restart" });
    } else {
      info = yield* runtime.ensureDesktop(input.name);
    }
    const desktop = info.desktop;
    if (desktop === null) {
      return yield* new MicroVmError({
        operation: "desktop",
        detail: `${info.name} lost its desktop profile.`,
      });
    }
    const probe = yield* Effect.promise(() => probeDesktop(desktop.viewerUrl));
    if (input.action !== "open" || !probe.ready) {
      return {
        name: info.name,
        desktop,
        ready: probe.ready,
        statusCode: probe.statusCode,
        preview: null,
      };
    }
    const scope = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.mapError(
        (cause) =>
          new MicroVmError({
            operation: "desktop-open",
            detail: cause.message,
          }),
      ),
    );
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const preview = yield* broker
      .invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: {
          url: desktop.viewerUrl,
          open: true,
          show: true,
          reuseExistingTab: false,
        },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new MicroVmError({
              operation: "desktop-open",
              detail: cause.message,
            }),
        ),
      );
    return {
      name: info.name,
      desktop,
      ready: true,
      statusCode: probe.statusCode,
      preview,
    };
  }),
  microvm_remove: Effect.fn("MicroVmToolkit.remove")(function* (input) {
    yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    yield* runtime.remove(input);
    return { removed: true };
  }),
} satisfies Parameters<typeof MicroVmToolkit.toLayer>[0];

export const MicroVmToolkitHandlersLive = MicroVmToolkit.toLayer(handlers);
