import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ResearchToolResult, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CoagentRegistryLive } from "../../coagents/Layers/CoagentRegistry.ts";
import { CoagentRegistry } from "../../coagents/Services/CoagentRegistry.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ResearchToolController } from "../Services/ResearchToolController.ts";
import { FindingReviewStoreLive } from "./FindingReviewStore.ts";
import { ResearchToolControllerLive } from "./ResearchToolController.ts";

const layer = it.layer(
  ResearchToolControllerLive.pipe(
    Layer.provideMerge(FindingReviewStoreLive),
    Layer.provideMerge(CoagentRegistryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(ResearchToolResult));
const resultFromResponse = (response: {
  readonly contentItems: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}) => {
  const item = response.contentItems[0];
  assert.equal(item?.type, "inputText");
  return decodeResult(item?.text ?? "");
};

const jsonFromResponse = (response: {
  readonly contentItems: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}) => {
  const item = response.contentItems[0];
  assert.equal(item?.type, "inputText");
  return JSON.parse(item?.text ?? "") as Record<string, unknown>;
};

layer("ResearchToolController", (it) => {
  it.effect("calculates CVSS locally without Judge or Proteus state", () =>
    Effect.gen(function* () {
      const controller = yield* ResearchToolController;
      assert(controller);
      const threadId = ThreadId.make("thread-cvss");
      const context = {
        projectId: ProjectId.make("project-cvss"),
        threadId,
        cwd: process.cwd(),
      };

      const calculated = jsonFromResponse(
        yield* controller.handle(context, {
          namespace: "research",
          tool: "calculate_cvss",
          callId: "call-cvss",
          threadId,
          turnId: "turn-cvss",
          arguments: {
            vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N",
          },
        }),
      );
      assert.equal(calculated.version, "4.0");
      assert.equal(calculated.score, 9.3);
      assert.equal(calculated.severity, "critical");
    }),
  );

  it.effect("submits only workspace finding and PoC artifacts to the independent Judge", () =>
    Effect.gen(function* () {
      const controller = yield* ResearchToolController;
      assert(controller);
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "erebus-review-" });
      yield* fileSystem.makeDirectory(path.join(root, "findings"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(root, "pocs", "finding-1"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(path.join(root, "findings", "finding-1.md"), "Finding");
      yield* fileSystem.writeFileString(
        path.join(root, "pocs", "finding-1", "poc.js"),
        "console.log('poc')",
      );
      const threadId = ThreadId.make("thread-review");
      const context = { projectId: ProjectId.make("project-review"), threadId, cwd: root };

      const response = yield* controller.handle(context, {
        namespace: "research",
        tool: "submit_finding",
        callId: "call-1",
        threadId,
        turnId: "turn-1",
        arguments: {
          findingId: "finding-1",
          revision: 1,
          supersedesEvaluationId: null,
          title: "Boundary confusion",
          target: "Target 1.0 on Windows",
          findingPath: "findings/finding-1.md",
          pocPath: "pocs/finding-1",
        },
      });
      const result = resultFromResponse(response);
      assert.isTrue(result.accepted);
      assert.equal(result.status, "pendingJudge");
      assert.include(result.message, "separate follow-up turn");

      const status = resultFromResponse(
        yield* controller.handle(context, {
          namespace: "research",
          tool: "get_status",
          callId: "call-2",
          threadId,
          turnId: "turn-1",
          arguments: { findingId: "finding-1" },
        }),
      );
      assert.equal(status.status, "pending");
      assert.include(status.message, "pending Judge review");
    }),
  );

  it.effect("rejects paths outside canonical artifact roots and co-agent submissions", () =>
    Effect.gen(function* () {
      const controller = yield* ResearchToolController;
      const registry = yield* CoagentRegistry;
      assert(controller);
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "erebus-review-invalid-" });
      yield* fileSystem.writeFileString(`${root}\\outside.md`, "outside");
      const projectId = ProjectId.make("project-review-invalid");
      const parentThreadId = ThreadId.make("thread-parent");
      const childThreadId = ThreadId.make("thread-child");
      const baseArguments = {
        findingId: "finding-invalid",
        revision: 1,
        supersedesEvaluationId: null,
        title: "Invalid",
        target: "Target 1.0",
        findingPath: "outside.md",
        pocPath: null,
      } as const;
      const invalid = resultFromResponse(
        yield* controller.handle(
          { projectId, threadId: parentThreadId, cwd: root },
          {
            namespace: "research",
            tool: "submit_finding",
            callId: "call-invalid",
            threadId: parentThreadId,
            turnId: "turn-invalid",
            arguments: baseArguments,
          },
        ),
      );
      assert.isFalse(invalid.accepted);
      assert.include(invalid.message, "NO JUDGE JOB CREATED");

      yield* registry.upsert({
        childThreadId,
        parentThreadId,
        projectId,
        assignment: "Inspect a separate parser sink",
        creationMode: "blank",
        status: "ready",
        error: null,
        createdAt: "2026-09-12T12:00:00.000Z",
        updatedAt: "2026-09-12T12:00:00.000Z",
      });
      const coagentCvss = jsonFromResponse(
        yield* controller.handle(
          { projectId, threadId: childThreadId, cwd: root },
          {
            namespace: "research",
            tool: "calculate_cvss",
            callId: "call-child-cvss",
            threadId: childThreadId,
            turnId: "turn-child",
            arguments: {
              vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L",
            },
          },
        ),
      );
      assert.equal(coagentCvss.score, 7.3);
      const coagent = resultFromResponse(
        yield* controller.handle(
          { projectId, threadId: childThreadId, cwd: root },
          {
            namespace: "research",
            tool: "submit_finding",
            callId: "call-child",
            threadId: childThreadId,
            turnId: "turn-child",
            arguments: baseArguments,
          },
        ),
      );
      assert.isFalse(coagent.accepted);
      assert.include(coagent.message, "co-agent cannot submit");
    }),
  );
});
