import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ResearchEvaluationId,
  ResearchFindingId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { FindingReviewStore } from "../Services/FindingReviewStore.ts";
import { FindingReviewStoreLive } from "./FindingReviewStore.ts";

const layer = it.layer(
  FindingReviewStoreLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const findingId = ResearchFindingId.make("finding-1");
const submittedAt = "2026-09-12T12:00:00.000Z";

layer("FindingReviewStore", (it) => {
  it.effect("persists an independent review and exposes pending delivery", () =>
    Effect.gen(function* () {
      const store = yield* FindingReviewStore;
      const first = yield* store.submit({
        commandId: CommandId.make("submit-1"),
        projectId,
        threadId,
        submission: {
          findingId,
          revision: 1,
          supersedesEvaluationId: null,
          title: "Boundary confusion",
          target: "Target 1.0 on Windows",
          findingPath: "findings/boundary-confusion.md",
          pocPath: "pocs/boundary-confusion",
          submittedAt,
        },
      });
      assert.isTrue(first.reviewRequested);
      assert.lengthOf(yield* store.listUnreviewed(), 1);

      const evaluationId = ResearchEvaluationId.make("evaluation-1");
      yield* store.recordEvaluation({
        projectId,
        threadId,
        evaluation: {
          evaluationId,
          findingId,
          findingRevision: 1,
          verdict: "accepted",
          confidence: 0.9,
          gates: [{ gateId: "J1", status: "pass", reason: "Passed", evidence: ["finding"] }],
          summary: "Accepted",
          nextAction: null,
          cvssV31: null,
          runtime: {
            policyVersion: 24,
            policyDigest: `sha256:${"a".repeat(64)}`,
            model: "judge-model",
            reasoningEffort: "xhigh",
          },
          evaluatedAt: "2026-09-12T12:01:00.000Z",
        },
      });

      assert.lengthOf(yield* store.listUnreviewed(), 0);
      assert.lengthOf(yield* store.listPendingDelivery(), 1);
      yield* store.markDelivered({
        threadId,
        evaluationId,
        deliveredAt: "2026-09-12T12:02:00.000Z",
      });
      assert.lengthOf(yield* store.listPendingDelivery(), 0);
    }),
  );

  it.effect("retries an unchanged reviewBlocked revision without comparing server timestamps", () =>
    Effect.gen(function* () {
      const store = yield* FindingReviewStore;
      const retryFindingId = ResearchFindingId.make("finding-review-blocked");
      const submission = {
        findingId: retryFindingId,
        revision: 1,
        supersedesEvaluationId: null,
        title: "Review retry",
        target: "Target 2.0",
        findingPath: "findings/retry.md",
        pocPath: null,
        submittedAt,
      } as const;
      yield* store.submit({
        commandId: CommandId.make("submit-retry-1"),
        projectId,
        threadId,
        submission,
      });
      yield* store.recordEvaluation({
        projectId,
        threadId,
        evaluation: {
          evaluationId: ResearchEvaluationId.make("evaluation-blocked"),
          findingId: retryFindingId,
          findingRevision: 1,
          verdict: "reviewBlocked",
          confidence: 1,
          gates: [{ gateId: "J1", status: "unknown", reason: "Unavailable", evidence: [] }],
          summary: "Evaluator unavailable",
          nextAction: "Retry",
          cvssV31: null,
          runtime: {
            policyVersion: 24,
            policyDigest: `sha256:${"b".repeat(64)}`,
            model: "judge-model",
            reasoningEffort: "xhigh",
          },
          evaluatedAt: "2026-09-12T12:01:00.000Z",
        },
      });

      const retried = yield* store.submit({
        commandId: CommandId.make("submit-retry-2"),
        projectId,
        threadId,
        submission: { ...submission, submittedAt: "2026-09-12T12:03:00.000Z" },
      });
      assert.isTrue(retried.replayed);
      assert.isTrue(retried.reviewRequested);
    }),
  );

  it.effect("selects one latest pending delivery when evaluations share a timestamp", () =>
    Effect.gen(function* () {
      const store = yield* FindingReviewStore;
      const tiedFindingId = ResearchFindingId.make("finding-tied-reviews");
      const tiedThreadId = ThreadId.make("thread-tied-reviews");
      const submission = {
        findingId: tiedFindingId,
        revision: 1,
        supersedesEvaluationId: null,
        title: "Tied review timestamps",
        target: "Target 3.0",
        findingPath: "findings/tied.md",
        pocPath: null,
        submittedAt,
      } as const;
      yield* store.submit({
        commandId: CommandId.make("submit-tied"),
        projectId,
        threadId: tiedThreadId,
        submission,
      });

      const runtime = {
        policyVersion: 24,
        policyDigest: `sha256:${"c".repeat(64)}`,
        model: "judge-model",
        reasoningEffort: "xhigh",
      } as const;
      const evaluatedAt = "2026-09-12T12:04:00.000Z";
      yield* store.recordEvaluation({
        projectId,
        threadId: tiedThreadId,
        evaluation: {
          evaluationId: ResearchEvaluationId.make("evaluation-tied-a"),
          findingId: tiedFindingId,
          findingRevision: 1,
          verdict: "reviewBlocked",
          confidence: 1,
          gates: [{ gateId: "J1", status: "unknown", reason: "Blocked", evidence: [] }],
          summary: "Blocked",
          nextAction: "Retry",
          cvssV31: null,
          runtime,
          evaluatedAt,
        },
      });
      yield* store.submit({
        commandId: CommandId.make("submit-tied-retry"),
        projectId,
        threadId: tiedThreadId,
        submission: { ...submission, submittedAt: "2026-09-12T12:05:00.000Z" },
      });
      yield* store.recordEvaluation({
        projectId,
        threadId: tiedThreadId,
        evaluation: {
          evaluationId: ResearchEvaluationId.make("evaluation-tied-b"),
          findingId: tiedFindingId,
          findingRevision: 1,
          verdict: "accepted",
          confidence: 0.9,
          gates: [{ gateId: "J1", status: "pass", reason: "Passed", evidence: ["finding"] }],
          summary: "Accepted",
          nextAction: null,
          cvssV31: null,
          runtime,
          evaluatedAt,
        },
      });

      const tiedPending = (yield* store.listPendingDelivery()).filter(
        (record) => record.threadId === tiedThreadId,
      );
      assert.lengthOf(tiedPending, 1);
      assert.equal(tiedPending[0]?.evaluations.at(-1)?.evaluationId, "evaluation-tied-b");
    }),
  );
});
