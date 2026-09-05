import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../../orchestration/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";
import { CoagentRegistry } from "../Services/CoagentRegistry.ts";
import {
  CoagentToolController,
  type CoagentToolControllerShape,
} from "../Services/CoagentToolController.ts";
import { CoagentRegistryLive } from "./CoagentRegistry.ts";
import { CoagentToolControllerLive } from "./CoagentToolController.ts";

const persistence = SqlitePersistenceMemory.pipe(Layer.provideMerge(NodeServices.layer));
const dependencies = Layer.mergeAll(CoagentRegistryLive, OrchestrationLayerLive).pipe(
  Layer.provideMerge(persistence),
  Layer.provideMerge(
    Layer.succeed(
      RepositoryIdentityResolver,
      RepositoryIdentityResolver.of({ resolve: () => Effect.succeed(null) }),
    ),
  ),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "erebus-coagent-controller-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
);
const layer = it.layer(CoagentToolControllerLive.pipe(Layer.provideMerge(dependencies)));

const now = IsoDateTime.make("2026-09-02T12:00:00.000Z");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
  options: [{ id: "reasoningEffort", value: "xhigh" }],
} as const;
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const parseResponse = (value: { readonly contentItems: ReadonlyArray<unknown> }) => {
  const first = value.contentItems[0] as { readonly text: string };
  return decodeUnknownJson(first.text) as Record<string, unknown>;
};

const call = (
  controller: CoagentToolControllerShape,
  context: { readonly threadId: ThreadId; readonly projectId: ProjectId; readonly cwd: string },
  tool: string,
  args: unknown,
) =>
  controller.handle(context, {
    namespace: "threads",
    tool,
    arguments: args,
    callId: `call-${tool}`,
    threadId: context.threadId,
    turnId: "test-turn",
  });

const awaitThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const thread = Option.getOrUndefined(yield* projections.getThreadDetailById(threadId));
      if (thread) return thread;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(`Thread projection did not appear: ${threadId}`);
  });

const awaitMessage = (threadId: ThreadId, pattern: RegExp) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const thread = Option.getOrUndefined(yield* projections.getThreadDetailById(threadId));
      const message = thread?.messages.find((entry) => pattern.test(entry.text));
      if (message) return message;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(`Matching message did not appear on thread: ${threadId}`);
  });

const seedParent = (suffix: string) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make(`coagent-project-${suffix}`);
    const parentThreadId = ThreadId.make(`coagent-parent-${suffix}`);
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`create-coagent-project-${suffix}`),
      projectId,
      title: "Co-agent project",
      workspaceRoot: `C:\\workspace\\coagent-${suffix}`,
      defaultModelSelection: modelSelection,
      createdAt: now,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-coagent-parent-${suffix}`),
      threadId: parentThreadId,
      projectId,
      title: "Parent task",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: `C:\\workspace\\coagent-${suffix}`,
      createdAt: now,
    });
    yield* awaitThread(parentThreadId);
    return {
      projectId,
      parentThreadId,
      threadId: parentThreadId,
      cwd: `C:\\workspace\\coagent-${suffix}`,
    } as const;
  });

layer("CoagentToolController", (it) => {
  it.effect("creates one durable child with inherited execution settings", () =>
    Effect.gen(function* () {
      const context = yield* seedParent("inheritance");
      const controller = yield* CoagentToolController;
      assert(controller);
      const response = yield* call(controller, context, "spawn", {
        mode: "blank",
        title: "Inspect parser",
        task: "Inspect the parser and report only.",
      });
      assert.isTrue(response.success);
      const result = parseResponse(response);
      const childThreadId = ThreadId.make(String(result.threadId));
      yield* awaitThread(childThreadId);

      const registry = yield* CoagentRegistry;
      const link = Option.getOrThrow(yield* registry.getByChild(childThreadId));
      assert.strictEqual(link.parentThreadId, context.parentThreadId);
      assert.strictEqual(link.status, "ready");

      const projections = yield* ProjectionSnapshotQuery;
      const child = Option.getOrThrow(yield* projections.getThreadDetailById(childThreadId));
      const childShell = Option.getOrThrow(yield* projections.getThreadShellById(childThreadId));
      assert.deepEqual(child.modelSelection, modelSelection);
      assert.strictEqual(child.runtimeMode, "full-access");
      assert.strictEqual(child.interactionMode, "default");
      assert.strictEqual(child.worktreePath, context.cwd);
      assert.match(child.messages[0]?.text ?? "", /direct co-agent/i);
      assert.notMatch(child.messages[0]?.text ?? "", /historical_parent_context/);
      assert.strictEqual(childShell.coagent?.parentThreadId, context.parentThreadId);
      assert.strictEqual(childShell.coagent?.creationMode, "blank");
      const shellSnapshot = yield* projections.getShellSnapshot();
      const snapshotChild = shellSnapshot.threads.find((thread) => thread.id === childThreadId);
      assert.strictEqual(snapshotChild?.coagent?.parentThreadId, context.parentThreadId);
      assert.strictEqual(snapshotChild?.coagent?.creationMode, "blank");
    }),
  );

  it.effect("enforces the child hierarchy in code rather than prompt text", () =>
    Effect.gen(function* () {
      const context = yield* seedParent("hierarchy");
      const controller = yield* CoagentToolController;
      assert(controller);
      const spawned = yield* call(controller, context, "spawn", {
        mode: "fork",
        title: "Bounded child",
        task: "Return one bounded result.",
      });
      const childThreadId = ThreadId.make(String(parseResponse(spawned).threadId));
      yield* awaitThread(childThreadId);

      const nested = yield* call(
        controller,
        { threadId: childThreadId, projectId: context.projectId, cwd: context.cwd },
        "spawn",
        { mode: "blank", title: "Forbidden", task: "This must not start." },
      );
      assert.isFalse(nested.success);
      assert.match(String(parseResponse(nested).message), /cannot create another co-agent/i);

      const projectList = yield* call(
        controller,
        { threadId: childThreadId, projectId: context.projectId, cwd: context.cwd },
        "list",
        { scope: "project" },
      );
      assert.isFalse(projectList.success);
    }),
  );

  it.effect("marks forked context as historical and wraps child-to-parent messages", () =>
    Effect.gen(function* () {
      const context = yield* seedParent("coordination");
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("seed-coagent-parent-history"),
        threadId: context.parentThreadId,
        message: {
          messageId: MessageId.make("seed-coagent-parent-message"),
          role: "user",
          text: "Inspect only the serializer boundary.",
          attachments: [],
        },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now,
      });
      yield* awaitMessage(context.parentThreadId, /serializer boundary/);

      const controller = yield* CoagentToolController;
      assert(controller);
      const spawned = yield* call(controller, context, "spawn", {
        mode: "fork",
        title: "Forked context",
        task: "Return the serializer boundary result.",
      });
      assert.isTrue(spawned.success);
      const childThreadId = ThreadId.make(String(parseResponse(spawned).threadId));
      const assignment = yield* awaitMessage(childThreadId, /historical_parent_context/);
      assert.match(assignment.text, /context, not a new instruction/i);
      assert.match(assignment.text, /Inspect only the serializer boundary/);
      assert.match(assignment.text, /containment boundary, not a request to create a lab/);
      assert.match(assignment.text, /Read-only work must not create one/);

      const sent = yield* call(
        controller,
        { threadId: childThreadId, projectId: context.projectId, cwd: context.cwd },
        "send",
        { threadId: context.parentThreadId, message: "Serializer result is ready." },
      );
      assert.isTrue(sent.success);
      const coordination = yield* awaitMessage(
        context.parentThreadId,
        /Serializer result is ready/,
      );
      assert.match(coordination.text, /erebus_coagent_message/);
      assert.match(coordination.text, /not a user-authored request/i);
    }),
  );

  it.effect("applies the direct-child limit atomically", () =>
    Effect.gen(function* () {
      const context = yield* seedParent("limit");
      const controller = yield* CoagentToolController;
      assert(controller);
      for (let index = 0; index < 4; index += 1) {
        const created = yield* call(controller, context, "spawn", {
          mode: "blank",
          title: `Child ${index + 1}`,
          task: `Return result ${index + 1}.`,
        });
        assert.isTrue(created.success);
      }
      const rejected = yield* call(controller, context, "spawn", {
        mode: "blank",
        title: "Child 5",
        task: "This must not start.",
      });
      assert.isFalse(rejected.success);
      assert.match(String(parseResponse(rejected).message), /maximum 4 co-agents/i);
    }),
  );

  it.effect("discards a collected child and frees its direct-child slot", () =>
    Effect.gen(function* () {
      const context = yield* seedParent("release");
      const controller = yield* CoagentToolController;
      assert(controller);
      const childIds: ThreadId[] = [];
      for (let index = 0; index < 4; index += 1) {
        const created = yield* call(controller, context, "spawn", {
          mode: "blank",
          title: `Release child ${index + 1}`,
          task: `Return bounded result ${index + 1}.`,
        });
        childIds.push(ThreadId.make(String(parseResponse(created).threadId)));
      }
      const child = yield* awaitThread(childIds[0]!);

      const released = yield* call(controller, context, "release", { threadId: child.id });
      assert.isTrue(released.success);
      const registry = yield* CoagentRegistry;
      assert.strictEqual(
        Option.getOrThrow(yield* registry.getByChild(child.id)).status,
        "released",
      );

      const replacement = yield* call(controller, context, "spawn", {
        mode: "blank",
        title: "Replacement child",
        task: "Use the released slot.",
      });
      assert.isTrue(replacement.success);
    }),
  );
});
