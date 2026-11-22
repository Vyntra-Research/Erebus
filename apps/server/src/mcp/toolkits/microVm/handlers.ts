import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerConfig from "../../../config.ts";
import * as MicroVmRuntime from "../../../microVm/MicroVmRuntime.ts";
import {
  MicroVmToolkit,
  type MicroVmCopyInput,
  type MicroVmExecInput,
  type MicroVmJobInput,
} from "./tools.ts";

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
  microvm_remove: Effect.fn("MicroVmToolkit.remove")(function* (input) {
    yield* McpInvocationContext.McpInvocationContext;
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* MicroVmRuntime.make(config.stateDir);
    yield* runtime.remove(input);
    return { removed: true };
  }),
} satisfies Parameters<typeof MicroVmToolkit.toLayer>[0];

export const MicroVmToolkitHandlersLive = MicroVmToolkit.toLayer(handlers);
