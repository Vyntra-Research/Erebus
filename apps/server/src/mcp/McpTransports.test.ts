import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ResearchFindingId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerConfig from "../config.ts";
import {
  ResearchToolController,
  type ResearchToolControllerShape,
} from "../research/Services/ResearchToolController.ts";
import { EREBUS_RESEARCH_TOOL_NAMES } from "../research/researchTools.ts";
import { ResearchToolControllerLive } from "../research/Layers/ResearchToolController.ts";
import { FindingReviewStoreLive } from "../research/Layers/FindingReviewStore.ts";
import { FindingReviewStore } from "../research/Services/FindingReviewStore.ts";
import { CoagentRegistryLive } from "../coagents/Layers/CoagentRegistry.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { McpSessionRegistry } from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as ResearchFallbackMcpHttpServer from "./ResearchFallbackMcpHttpServer.ts";

const threadId = ThreadId.make("transport-test-thread");
const projectId = ProjectId.make("transport-test-project");
const scope = (research: boolean): McpInvocationScope => ({
  environmentId: EnvironmentId.make("transport-test-environment"),
  threadId,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "transport-test-session",
  capabilities: new Set(research ? ["researchFallback"] : ["preview"]),
  issuedAt: 1,
});
const unused = () => Effect.die("Unused test service method");
const registry = McpSessionRegistry.of({
  issue: unused,
  resolve: (token) =>
    Effect.succeed(
      token === "research" ? scope(true) : token === "preview" ? scope(false) : undefined,
    ),
  touch: () => Effect.void,
  revokeThread: () => Effect.void,
  revokeProviderSession: () => Effect.void,
  revokeAll: Effect.void,
});
const projection = ProjectionSnapshotQuery.of({
  getCommandReadModel: unused,
  getSnapshot: unused,
  getShellSnapshot: unused,
  getArchivedShellSnapshot: unused,
  searchThreads: unused,
  getSnapshotSequence: unused,
  getCounts: unused,
  getActiveProjectByWorkspaceRoot: unused,
  getProjectShellById: unused,
  getFirstActiveThreadIdByProjectId: unused,
  getThreadCheckpointContext: () =>
    Effect.succeed(
      Option.some({
        threadId,
        projectId,
        workspaceRoot: "/workspace",
        worktreePath: null,
        checkpoints: [],
      }),
    ),
  getFullThreadDiffContext: unused,
  getThreadShellById: unused,
  getThreadDetailById: unused,
  getThreadDetailSnapshot: unused,
});
const toolList = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.Array(Schema.Struct({ name: Schema.String, inputSchema: Schema.Unknown })),
  }),
});
const requiredFields = Schema.decodeUnknownSync(
  Schema.Struct({ required: Schema.Array(Schema.String) }),
);
const callResult = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    content: Schema.Array(
      Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
    ),
  }),
});

it.effect("isolates browser and research catalogs and routes authorized Judge handoffs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "erebus-fallback-test-" });
      const checkpointContextReads = yield* Ref.make(0);
      const threadContextReads = yield* Ref.make(0);
      const projectContextId = yield* Ref.make<ProjectId | null>(projectId);
      const standaloneRoot = path.join(root, "userdata", "standalone-workspaces", threadId);
      yield* fileSystem.makeDirectory(path.join(root, "findings"));
      yield* fileSystem.makeDirectory(path.join(root, "pocs", "finding-1"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(root, "findings", "finding-1.md"), "Finding");
      yield* fileSystem.makeDirectory(path.join(standaloneRoot, "findings"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(standaloneRoot, "pocs", "finding-standalone"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        path.join(standaloneRoot, "findings", "finding-standalone.md"),
        "Standalone finding",
      );
      const reviewContext = yield* Layer.build(
        ResearchToolControllerLive.pipe(
          Layer.provideMerge(FindingReviewStoreLive),
          Layer.provide(CoagentRegistryLive),
          Layer.provide(SqlitePersistenceMemory),
          Layer.provide(NodeServices.layer),
        ),
      );
      const realController = yield* Effect.service(ResearchToolController).pipe(
        Effect.provide(reviewContext),
      );
      const reviews = yield* Effect.service(FindingReviewStore).pipe(Effect.provide(reviewContext));
      expect(realController).toBeDefined();
      const handled: Array<{
        readonly tool: string;
        readonly namespace: string | null | undefined;
        readonly threadId: string;
      }> = [];
      const controller: ResearchToolControllerShape = {
        principalInstructions: () => Effect.succeed(""),
        handle: (context, params) =>
          Effect.gen(function* () {
            const expectedProjectId = yield* Ref.get(projectContextId);
            expect(context).toEqual({
              projectId: expectedProjectId,
              threadId,
              cwd:
                params.tool === "calculate_cvss" || params.tool === "get_status"
                  ? process.cwd()
                  : expectedProjectId === null
                    ? standaloneRoot
                    : root,
            });
            handled.push({
              tool: params.tool,
              namespace: params.namespace,
              threadId: context.threadId,
            });
            return yield* realController!.handle(context, params);
          }),
      };
      const transports = Layer.mergeAll(
        McpHttpServer.layer,
        ResearchFallbackMcpHttpServer.layer,
      ).pipe(
        Layer.provide(Layer.succeed(McpSessionRegistry, registry)),
        Layer.provide(
          Layer.succeed(ProjectionSnapshotQuery, {
            ...projection,
            getThreadCheckpointContext: () =>
              Ref.update(checkpointContextReads, (count) => count + 1).pipe(
                Effect.as(Option.none()),
              ),
            getThreadShellById: () =>
              Ref.update(threadContextReads, (count) => count + 1).pipe(
                Effect.andThen(Ref.get(projectContextId)),
                Effect.map((currentProjectId) =>
                  Option.some({
                    id: threadId,
                    projectId: currentProjectId,
                    worktreePath: null,
                  } as never),
                ),
              ),
            getProjectShellById: () =>
              Effect.succeed(Option.some({ workspaceRoot: root } as never)),
          }),
        ),
        Layer.provide(Layer.succeed(ResearchToolController, controller)),
        Layer.provide(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
        Layer.provide(ServerConfig.layerTest(root, root)),
      );
      yield* HttpRouter.serve(transports, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const client = yield* HttpClient.HttpClient;
      const rpc = Effect.fn("McpTransports.test.rpc")(function* (
        path: string,
        token: string,
        method: string,
        params: unknown,
        sessionId?: string,
      ) {
        const response = yield* client.post(path, {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            "mcp-protocol-version": "2025-06-18",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: yield* HttpBody.json({ jsonrpc: "2.0", id: 1, method, params }),
        });
        expect(response.status).toBe(200);
        return { headers: response.headers, body: yield* response.json };
      });
      const initialize = {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "transport-test", version: "1.0.0" },
      };
      const browser = yield* rpc("/mcp", "preview", "initialize", initialize);
      const research = yield* rpc("/research-mcp", "research", "initialize", initialize);
      const browserList = yield* rpc(
        "/mcp",
        "preview",
        "tools/list",
        {},
        browser.headers["mcp-session-id"],
      );
      const researchList = yield* rpc(
        "/research-mcp",
        "research",
        "tools/list",
        {},
        research.headers["mcp-session-id"],
      );
      const browserNames = (yield* Schema.decodeUnknownEffect(toolList)(
        browserList.body,
      )).result.tools.map((t) => t.name);
      const researchTools = (yield* Schema.decodeUnknownEffect(toolList)(researchList.body)).result
        .tools;
      const researchNames = researchTools.map((t) => t.name);
      expect(browserNames).toContain("preview_status");
      expect(browserNames.some((name) => EREBUS_RESEARCH_TOOL_NAMES.includes(name))).toBe(false);
      expect(browserNames.some((name) => name.startsWith("threads_"))).toBe(false);
      expect(researchNames).toEqual(expect.arrayContaining(EREBUS_RESEARCH_TOOL_NAMES));
      expect(researchNames).toContain("threads_spawn");
      expect(researchNames.some((name) => name.startsWith("preview_"))).toBe(false);
      const threadsWait = researchTools.find((tool) => tool.name === "threads_wait")
        ?.inputSchema as
        | {
            readonly properties?: {
              readonly timeoutMs?: { readonly maximum?: number; readonly description?: string };
            };
          }
        | undefined;
      expect(threadsWait?.properties?.timeoutMs).toMatchObject({
        maximum: 60_000,
        description: expect.stringContaining("cannot exceed 60000"),
      });
      expect(
        requiredFields(researchTools.find((tool) => tool.name === "get_status")?.inputSchema)
          .required,
      ).toEqual([]);
      expect(
        requiredFields(researchTools.find((tool) => tool.name === "submit_finding")?.inputSchema)
          .required,
      ).toEqual([
        "findingId",
        "revision",
        "supersedesEvaluationId",
        "title",
        "target",
        "findingPath",
        "pocPath",
      ]);
      expect(researchNames).not.toContain("create_campaign");
      const call = {
        name: "submit_finding",
        arguments: {
          findingId: "finding-1",
          revision: 1,
          supersedesEvaluationId: null,
          title: "Boundary confusion",
          target: "Target 1.0 local test",
          findingPath: "findings/finding-1.md",
          pocPath: "pocs/finding-1",
        },
      };
      const submitted = yield* rpc(
        "/research-mcp",
        "research",
        "tools/call",
        call,
        research.headers["mcp-session-id"],
      );
      expect(
        (yield* Schema.decodeUnknownEffect(callResult)(submitted.body)).result.isError,
      ).not.toBe(true);
      expect(handled).toEqual([{ tool: "submit_finding", namespace: "research", threadId }]);
      expect(yield* Ref.get(checkpointContextReads)).toBe(0);
      expect(yield* Ref.get(threadContextReads)).toBe(1);
      const persisted = yield* reviews.listByThread(threadId);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.submission.findingId).toBe("finding-1");
      expect(persisted[0]?.submission.revision).toBe(1);
      const denied = yield* rpc(
        "/research-mcp",
        "preview",
        "tools/call",
        call,
        research.headers["mcp-session-id"],
      );
      expect((yield* Schema.decodeUnknownEffect(callResult)(denied.body)).result.isError).toBe(
        true,
      );
      expect(handled).toEqual([{ tool: "submit_finding", namespace: "research", threadId }]);
      expect(yield* reviews.listByThread(threadId)).toHaveLength(1);

      yield* Ref.set(projectContextId, null);
      const calculated = yield* rpc(
        "/research-mcp",
        "research",
        "tools/call",
        {
          name: "calculate_cvss",
          arguments: {
            vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N",
          },
        },
        research.headers["mcp-session-id"],
      );
      expect(
        (yield* Schema.decodeUnknownEffect(callResult)(calculated.body)).result.isError,
      ).not.toBe(true);
      const status = yield* rpc(
        "/research-mcp",
        "research",
        "tools/call",
        { name: "get_status", arguments: { findingId: "finding-1" } },
        research.headers["mcp-session-id"],
      );
      expect((yield* Schema.decodeUnknownEffect(callResult)(status.body)).result.isError).not.toBe(
        true,
      );
      const standaloneSubmission = yield* rpc(
        "/research-mcp",
        "research",
        "tools/call",
        {
          name: "submit_finding",
          arguments: {
            findingId: "finding-standalone",
            revision: 1,
            supersedesEvaluationId: null,
            title: "Standalone boundary confusion",
            target: "Target 1.0 local test",
            findingPath: "findings/finding-standalone.md",
            pocPath: "pocs/finding-standalone",
          },
        },
        research.headers["mcp-session-id"],
      );
      const standaloneSubmissionResult = yield* Schema.decodeUnknownEffect(callResult)(
        standaloneSubmission.body,
      );
      expect(standaloneSubmissionResult.result.isError).not.toBe(true);
      expect(handled.map(({ tool }) => tool)).toEqual([
        "submit_finding",
        "calculate_cvss",
        "get_status",
        "submit_finding",
      ]);
      expect(yield* Ref.get(threadContextReads)).toBe(2);
      const standaloneReviews = yield* reviews.listByThread(
        threadId,
        ResearchFindingId.make("finding-standalone"),
      );
      expect(standaloneReviews).toHaveLength(1);
      expect(standaloneReviews[0]?.projectId).toBeNull();
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpServer.layerTest))),
);
