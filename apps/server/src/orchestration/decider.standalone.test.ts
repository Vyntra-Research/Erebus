import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-10-18T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
};

function readModel(threadProjectId: ProjectId | null): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: projectId,
        title: "Project",
        workspaceRoot: "C:/work/project",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: threadId,
        projectId: threadProjectId,
        title: "Thread",
        coagent: null,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: "C:/work/project",
        linkedPullRequest: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        titleRegeneration: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("standalone thread decider", (it) => {
  it.effect("creates a thread without requiring a project", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("create-standalone"),
          threadId: ThreadId.make("standalone"),
          projectId: null,
          title: "Standalone",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
        },
        readModel: { snapshotSequence: 0, projects: [], threads: [], updatedAt: NOW },
      });

      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.created");
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.projectId).toBeNull();
      }
    }),
  );

  it.effect("moves a linked thread out of its project and clears workspace metadata", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("unlink-thread"),
          threadId,
          projectId: null,
        },
        readModel: readModel(projectId),
      });

      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.meta-updated");
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload).toMatchObject({
          projectId: null,
          branch: null,
          worktreePath: null,
          linkedPullRequest: null,
        });
      }
    }),
  );

  it.effect("links a standalone thread to an existing project", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("link-thread"),
          threadId,
          projectId,
        },
        readModel: readModel(null),
      });

      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.meta-updated");
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.projectId).toBe(projectId);
      }
    }),
  );
});
