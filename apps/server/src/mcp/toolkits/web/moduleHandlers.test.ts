import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import type * as ProcessRunner from "../../../processRunner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PentestModuleRuntime from "../../PentestModuleRuntime.ts";
import { WebModuleToolkitHandlersLive } from "./moduleHandlers.ts";
import { WebModuleToolkit } from "./moduleTools.ts";

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-web-module-test"),
  threadId: ThreadId.make("thread-web-module-test"),
  providerSessionId: "provider-session-web-module-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["web"]),
  issuedAt: 1,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "web-module-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const processOutput = (
  overrides: Partial<PentestModuleRuntime.PentestModuleExecutionResult> = {},
): PentestModuleRuntime.PentestModuleExecutionResult => ({
  stdout: "",
  stderr: "",
  code: 0 as ProcessRunner.ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  version: "test-version",
  ...overrides,
});

const makeLayer = (runtime: PentestModuleRuntime.PentestModuleRuntime["Service"]) =>
  McpServer.toolkit(WebModuleToolkit).pipe(
    Layer.provide(WebModuleToolkitHandlersLive),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(Layer.succeed(PentestModuleRuntime.PentestModuleRuntime, runtime)),
  );

const callTool = (
  args: Record<string, unknown>,
  scope: McpInvocationContext.McpInvocationScope = invocation,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "web_module_exec", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("passes CLI input unchanged and returns unmasked raw process output", () => {
  const calls: PentestModuleRuntime.PentestModuleExecutionInput[] = [];
  const runtime = PentestModuleRuntime.PentestModuleRuntime.of({
    execute: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return processOutput({
          stdout: "secret-value-123456\nraw-json-line\n",
          stderr: "module warning\n",
          code: 2 as ProcessRunner.ProcessRunOutput["code"],
          stdoutTruncated: true,
        });
      }),
  });

  return Effect.gen(function* () {
    const result = yield* callTool({
      module: "secrethound",
      args: ["scan", "--format", "json", "--custom-flag=value"],
      cwd: "C:\\authorized",
      stdin: "https://example.test/app.js\n",
      maxOutputBytes: 123_456,
    });

    expect(result.isError).toBe(false);
    expect(calls).toEqual([
      {
        module: "secrethound",
        args: ["scan", "--format", "json", "--custom-flag=value"],
        cwd: "C:\\authorized",
        stdin: "https://example.test/app.js\n",
        maxOutputBytes: 123_456,
      },
    ]);
    expect(result.structuredContent).toEqual({
      module: "secrethound",
      version: "test-version",
      exitCode: 2,
      stdout: "secret-value-123456\nraw-json-line\n",
      stderr: "module warning\n",
      stdoutTruncated: true,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    });
  }).pipe(Effect.provide(makeLayer(runtime)));
});

it.effect("checks the web capability before running a module", () => {
  let calls = 0;
  const runtime = PentestModuleRuntime.PentestModuleRuntime.of({
    execute: () => {
      calls += 1;
      return Effect.succeed(processOutput());
    },
  });

  return Effect.gen(function* () {
    const result = yield* callTool(
      { module: "katana", args: ["-h"] },
      { ...invocation, capabilities: new Set() },
    );
    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  }).pipe(Effect.provide(makeLayer(runtime)));
});

it.effect("returns module launch diagnostics in MCP error content", () => {
  const runtime = PentestModuleRuntime.PentestModuleRuntime.of({
    execute: (input) =>
      Effect.fail(
        new PentestModuleRuntime.PentestModuleExecutionError({
          module: input.module,
          operation: "run",
          detail: "Katana could not run: working directory does not exist.",
        }),
      ),
  });

  return Effect.gen(function* () {
    const result = yield* callTool({ module: "katana", args: ["-u", "https://example.com"] });
    const errorText = result.content
      .flatMap((content) => (content.type === "text" ? [content.text] : []))
      .join("\n");
    expect(result.isError).toBe(true);
    expect(errorText).toContain("Katana could not run");
    expect(errorText).toContain("working directory does not exist");
  }).pipe(Effect.provide(makeLayer(runtime)));
});
