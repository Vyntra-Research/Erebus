import * as NodeCrypto from "node:crypto";

import type { ResearchProteusHealth } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";

import packageJson from "../../package.json" with { type: "json" };
import { CoagentToolController } from "../coagents/Services/CoagentToolController.ts";
import { EREBUS_THREADS_DYNAMIC_TOOL } from "../coagents/coagentTools.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ResearchToolController } from "../research/Services/ResearchToolController.ts";
import { EREBUS_RESEARCH_DYNAMIC_TOOL } from "../research/researchTools.ts";
import { McpAuthMiddlewareLive } from "./McpHttpServer.ts";
import { McpInvocationContext } from "./McpInvocationContext.ts";
import { readMcpProviderSession } from "./McpProviderSession.ts";

const unavailableProteusHealth = (): ResearchProteusHealth => ({
  runtime: "unknown",
  plugin: "unknown",
  skills: "unknown",
  mcp: "unknown",
  version: null,
  message: "Proteus health was not available for this resumed Codex session.",
  checkedAt: "1970-01-01T00:00:00.000Z",
});

const failureResult = (message: string) =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: message }],
  });

const registerResearchFallbackTools = Effect.fn("ResearchFallbackMcpHttpServer.registerTools")(
  function* () {
    const server = yield* McpServer.McpServer;
    const projectionQuery = yield* ProjectionSnapshotQuery;
    const researchToolController = yield* ResearchToolController;
    const coagentToolController = yield* CoagentToolController;

    for (const tool of EREBUS_RESEARCH_DYNAMIC_TOOL.tools) {
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }),
        annotations: Context.empty(),
        handle: (payload) =>
          Effect.withFiber((fiber) => {
            const invocation = Context.getUnsafe(fiber.context, McpInvocationContext);
            if (!invocation.capabilities.has("researchFallback")) {
              return Effect.succeed(
                failureResult("This credential is not authorized for research fallback tools."),
              );
            }
            if (!researchToolController) {
              return Effect.succeed(
                failureResult("The Erebus research control plane is unavailable."),
              );
            }

            return projectionQuery.getThreadCheckpointContext(invocation.threadId).pipe(
              Effect.flatMap((contextOption) => {
                const threadContext = Option.getOrUndefined(contextOption);
                if (!threadContext) {
                  return Effect.succeed(
                    failureResult(
                      "The Erebus project context for this task could not be resolved.",
                    ),
                  );
                }
                const proteus =
                  readMcpProviderSession(invocation.threadId)?.proteusHealth ??
                  unavailableProteusHealth();
                return researchToolController
                  .handle(
                    {
                      projectId: threadContext.projectId,
                      threadId: invocation.threadId,
                      cwd: threadContext.worktreePath ?? threadContext.workspaceRoot,
                      proteus,
                    },
                    {
                      namespace: EREBUS_RESEARCH_DYNAMIC_TOOL.name,
                      tool: tool.name,
                      arguments: payload,
                      callId: `mcp:${NodeCrypto.randomUUID()}`,
                      threadId: invocation.threadId,
                      turnId: "mcp-fallback",
                    },
                  )
                  .pipe(
                    Effect.map(
                      (response) =>
                        new McpSchema.CallToolResult({
                          isError: !response.success,
                          content: response.contentItems.map((item) =>
                            item.type === "inputText"
                              ? { type: "text" as const, text: item.text }
                              : {
                                  type: "text" as const,
                                  text: JSON.stringify(item),
                                },
                          ),
                        }),
                    ),
                  );
              }),
              Effect.catchCause((cause) =>
                Effect.logError("research fallback MCP tool failed", {
                  tool: tool.name,
                  threadId: invocation.threadId,
                  cause,
                }).pipe(Effect.as(failureResult("The Erebus research fallback call failed."))),
              ),
            );
          }),
      });
    }

    for (const tool of EREBUS_THREADS_DYNAMIC_TOOL.tools) {
      const fallbackToolName = `threads_${tool.name}`;
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: fallbackToolName,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }),
        annotations: Context.empty(),
        handle: (payload) =>
          Effect.withFiber((fiber) => {
            const invocation = Context.getUnsafe(fiber.context, McpInvocationContext);
            if (!invocation.capabilities.has("researchFallback")) {
              return Effect.succeed(
                failureResult("This credential is not authorized for Erebus fallback tools."),
              );
            }
            if (!coagentToolController) {
              return Effect.succeed(
                failureResult("The Erebus task coordination control plane is unavailable."),
              );
            }

            return projectionQuery.getThreadCheckpointContext(invocation.threadId).pipe(
              Effect.flatMap((contextOption) => {
                const threadContext = Option.getOrUndefined(contextOption);
                if (!threadContext) {
                  return Effect.succeed(
                    failureResult(
                      "The Erebus project context for this task could not be resolved.",
                    ),
                  );
                }
                return coagentToolController
                  .handle(
                    {
                      projectId: threadContext.projectId,
                      threadId: invocation.threadId,
                      cwd: threadContext.worktreePath ?? threadContext.workspaceRoot,
                    },
                    {
                      namespace: EREBUS_THREADS_DYNAMIC_TOOL.name,
                      tool: tool.name,
                      arguments: payload,
                      callId: `mcp:${NodeCrypto.randomUUID()}`,
                      threadId: invocation.threadId,
                      turnId: "mcp-fallback",
                    },
                  )
                  .pipe(
                    Effect.map(
                      (response) =>
                        new McpSchema.CallToolResult({
                          isError: !response.success,
                          content: response.contentItems.map((item) =>
                            item.type === "inputText"
                              ? { type: "text" as const, text: item.text }
                              : { type: "text" as const, text: JSON.stringify(item) },
                          ),
                        }),
                    ),
                  );
              }),
              Effect.catchCause((cause) =>
                Effect.logError("task coordination fallback MCP tool failed", {
                  tool: fallbackToolName,
                  threadId: invocation.threadId,
                  cause,
                }).pipe(
                  Effect.as(failureResult("The Erebus task coordination fallback call failed.")),
                ),
              ),
            );
          }),
      });
    }
  },
);

const RegistrationLive = Layer.effectDiscard(registerResearchFallbackTools());

const TransportLive = McpServer.layerHttp({
  name: "Erebus Control",
  version: packageJson.version,
  path: "/research-mcp",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(McpAuthMiddlewareLive));

export const layer = RegistrationLive.pipe(Layer.provideMerge(TransportLive));
