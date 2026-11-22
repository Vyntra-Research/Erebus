import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PentestModuleRuntime from "../../PentestModuleRuntime.ts";
import { WebModuleToolkit, type WebModuleExecInput } from "./moduleTools.ts";

const handlers = {
  web_module_exec: Effect.fn("WebModuleToolkit.exec")(function* (input: WebModuleExecInput) {
    yield* McpInvocationContext.requireWebMcpCapability();
    const runtime = yield* PentestModuleRuntime.PentestModuleRuntime;
    const result = yield* runtime.execute({
      module: input.module,
      args: input.args,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
    });

    return {
      module: input.module,
      version: result.version,
      exitCode: result.code === null ? null : Number(result.code),
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      stdoutInvalidUtf8: result.stdoutInvalidUtf8,
      stderrInvalidUtf8: result.stderrInvalidUtf8,
    };
  }),
} satisfies Parameters<typeof WebModuleToolkit.toLayer>[0];

export const WebModuleToolkitHandlersLive = WebModuleToolkit.toLayer(handlers);
