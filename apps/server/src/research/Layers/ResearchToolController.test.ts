import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ResearchCampaignId, ResearchToolResult, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { layerTest as ServerSettingsLayerTest } from "../../serverSettings.ts";
import { ResearchEngine } from "../Services/ResearchEngine.ts";
import { ResearchToolController } from "../Services/ResearchToolController.ts";
import { ProteusBridge } from "../Services/ProteusBridge.ts";
import { ResearchCampaignStoreLive } from "./ResearchCampaignStore.ts";
import { ResearchEngineLive } from "./ResearchEngine.ts";
import { ResearchToolControllerLive } from "./ResearchToolController.ts";

const layer = it.layer(
  ResearchToolControllerLive.pipe(
    Layer.provideMerge(ResearchEngineLive),
    Layer.provideMerge(ResearchCampaignStoreLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettingsLayerTest()),
    Layer.provideMerge(
      Layer.succeed(
        ProteusBridge,
        ProteusBridge.of({
          readCampaign: (_root, campaignId) =>
            Effect.succeed({
              id: Number(campaignId.replace(/^\D/, "")),
              status: "active",
              campaignId: null,
            }),
          readBranch: (_root, branchId) =>
            Effect.succeed({
              id: Number(branchId.replace(/^\D/, "")),
              status: "open",
              campaignId: Number(branchId.replace(/^\D/, "")),
            }),
          readCheckpoint: (_root, checkpointId) =>
            Effect.succeed({
              id: Number(checkpointId.replace(/^\D/, "")),
              status: null,
              campaignId: 2,
            }),
        }),
      ),
    ),
  ),
);

const health = {
  runtime: "ready",
  plugin: "ready",
  skills: "ready",
  mcp: "ready",
  version: "2.1.5",
  message: null,
  checkedAt: "2026-08-27T12:00:00.000Z",
} as const;

const context = {
  projectId: ProjectId.make("project-1"),
  threadId: ThreadId.make("thread-1"),
  cwd: process.cwd(),
  proteus: health,
};
const providerThreadId = "provider-thread-1";

layer("ResearchToolController", (it) => {
  it.effect("injects harness-owned Observer policy into a registered contract", () =>
    Effect.gen(function* () {
      const controller = yield* ResearchToolController;
      const engine = yield* ResearchEngine;
      assert.isDefined(controller);
      const policyContext = { ...context, threadId: ThreadId.make("thread-policy") };
      yield* controller!.handle(policyContext, {
        namespace: "research",
        tool: "create_campaign",
        callId: "call-create-policy",
        threadId: "provider-thread-policy",
        turnId: "turn-1",
        arguments: { campaignId: "campaign-policy", proteusCampaignId: "C101" },
      });
      const registered = yield* controller!.handle(policyContext, {
        namespace: "research",
        tool: "register_contract",
        callId: "call-register-policy",
        threadId: "provider-thread-policy",
        turnId: "turn-1",
        arguments: {
          campaignId: "campaign-policy",
          contract: {
            id: "contract-policy",
            revision: 1,
            objective: "Find a realistic boundary violation.",
            target: "target",
            authorization: "Authorized local research.",
            attackerModel: "Unauthenticated external attacker.",
            impactThreshold: "Practical confidentiality or integrity impact.",
            scope: { included: ["target"], excluded: [], stopConditions: [] },
            strategy: ["Trace the boundary."],
            heuristics: ["Kill artificial scenarios."],
            gates: [{ id: "G1", title: "Impact", requirement: "Prove impact.", required: true }],
            duplicatePolicy: "Check prior findings.",
            labPolicy: "Use documented defaults.",
            reportPolicy: "Require reproducible evidence.",
            proteusCampaignId: "C101",
            createdAt: "2026-08-29T00:00:00.000Z",
          },
        },
      });
      const projection = yield* engine.findProjection(ResearchCampaignId.make("campaign-policy"));

      assert.isTrue(registered.success);
      assert.deepStrictEqual(projection?.contracts[0]?.observerPolicy, {
        messageWindow: 5,
        interventionConfidence: 0.8,
        cooldownMessages: 5,
        maxInterventionsPerTurn: 1,
      });
    }),
  );

  it.effect("returns an explicit same-revision retry contract for an invalid finding", () =>
    Effect.gen(function* () {
      const controller = yield* ResearchToolController;
      assert.isDefined(controller);
      const retryContext = { ...context, threadId: ThreadId.make("thread-retry") };
      yield* controller!.handle(retryContext, {
        namespace: "research",
        tool: "create_campaign",
        callId: "call-create-retry",
        threadId: "provider-thread-retry",
        turnId: "turn-1",
        arguments: { campaignId: "campaign-retry", proteusCampaignId: "C102" },
      });
      yield* controller!.handle(retryContext, {
        namespace: "research",
        tool: "register_contract",
        callId: "call-register-retry",
        threadId: "provider-thread-retry",
        turnId: "turn-1",
        arguments: {
          campaignId: "campaign-retry",
          contract: {
            id: "contract-retry",
            revision: 1,
            objective: "Find a realistic boundary violation.",
            target: "target",
            authorization: "Authorized local research.",
            attackerModel: "Unauthenticated external attacker.",
            impactThreshold: "Practical confidentiality or integrity impact.",
            scope: { included: ["target"], excluded: [], stopConditions: [] },
            strategy: ["Trace the boundary."],
            heuristics: ["Kill artificial scenarios."],
            gates: [{ id: "G1", title: "Impact", requirement: "Prove impact.", required: true }],
            duplicatePolicy: "Check prior findings.",
            labPolicy: "Use documented defaults.",
            reportPolicy: "Require reproducible evidence.",
            proteusCampaignId: "C102",
            createdAt: "2026-08-29T00:00:00.000Z",
          },
        },
      });
      yield* controller!.handle(retryContext, {
        namespace: "research",
        tool: "start",
        callId: "call-start-retry",
        threadId: "provider-thread-retry",
        turnId: "turn-1",
        arguments: {
          campaignId: "campaign-retry",
          contractId: "contract-retry",
          contractRevision: 1,
        },
      });
      const response = yield* controller!.handle(retryContext, {
        namespace: "research",
        tool: "submit_finding",
        callId: "call-submit-retry",
        threadId: "provider-thread-retry",
        turnId: "turn-2",
        arguments: {
          findingId: "finding-retry",
          revision: 1,
          supersedesEvaluationId: null,
          campaignId: "campaign-retry",
          contractId: "contract-retry",
          contractRevision: 1,
          title: "Candidate",
          mechanism: "Mechanism",
          targetVersions: ["1.0.0"],
          attacker: "Unauthenticated external attacker.",
          preconditions: [],
          impact: "Impact",
          exploitPath: ["input", "sink", "impact"],
          evidence: ["findings/finding-retry.md", "pocs/finding-retry"],
          negativeControls: [],
          duplicateCheck: "No duplicate found.",
          gateClaims: [{ gateId: "G1", status: "pass", evidence: ["proof"] }],
          proteusBranchId: "B102",
          submittedAt: "2026-08-29T00:01:00.000Z",
        },
      });
      const content = response.contentItems[0];

      assert.isFalse(response.success);
      assert.equal(content?.type, "inputText");
      if (content?.type === "inputText") {
        const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ResearchToolResult))(
          content.text,
        );
        assert.include(result.message, "SUBMISSION NOT RECORDED");
        assert.deepInclude(result.retry, {
          required: true,
          tool: "research.submit_finding",
          mode: "sameFindingRevision",
        });
      }
    }),
  );

  it.effect("creates one durable campaign and replays the same dynamic call id", () =>
    Effect.gen(function* () {
      const controller = yield* ResearchToolController;
      const engine = yield* ResearchEngine;
      assert.isDefined(controller);
      const call = {
        namespace: "research",
        tool: "create_campaign",
        callId: "call-create-1",
        threadId: providerThreadId,
        turnId: "turn-1",
        arguments: {
          campaignId: "campaign-controller-1",
          proteusCampaignId: "C1",
        },
      } as const;

      const first = yield* controller!.handle(context, call);
      const repeated = yield* controller!.handle(context, call);
      const projection = yield* engine.findProjection(
        ResearchCampaignId.make("campaign-controller-1"),
      );
      const status = yield* controller!.handle(context, {
        namespace: "research",
        tool: "get_status",
        callId: "call-status-1",
        threadId: providerThreadId,
        turnId: "turn-1",
        arguments: { campaignId: "campaign-controller-1" },
      });

      assert.isTrue(first.success);
      assert.isTrue(repeated.success);
      assert.isTrue(status.success);
      assert.equal(projection?.lastSequence, 1);
      assert.equal(projection?.campaign?.principalThreadId, context.threadId);
    }),
  );

  it.effect("rejects a campaign command from another project thread", () =>
    Effect.gen(function* () {
      const controller = yield* ResearchToolController;
      assert.isDefined(controller);
      yield* controller!.handle(context, {
        namespace: "research",
        tool: "create_campaign",
        callId: "call-create-2",
        threadId: providerThreadId,
        turnId: "turn-1",
        arguments: {
          campaignId: "campaign-controller-2",
          proteusCampaignId: "C2",
        },
      });

      const otherThread = ThreadId.make("thread-2");
      const response = yield* controller!.handle(
        { ...context, threadId: otherThread },
        {
          namespace: "research",
          tool: "checkpoint",
          callId: "call-cross-thread",
          threadId: "provider-thread-2",
          turnId: "turn-2",
          arguments: {
            campaignId: "campaign-controller-2",
            proteusCheckpointId: "K2",
            summary: "checkpoint",
            evidence: [],
            killedPaths: [],
            openDeviations: [],
            nextMove: "stop",
          },
        },
      );

      assert.isFalse(response.success);
    }),
  );

  it.effect("rejects a Proteus checkpoint from another campaign", () =>
    Effect.gen(function* () {
      const controller = yield* ResearchToolController;
      assert.isDefined(controller);
      const checkpointContext = { ...context, threadId: ThreadId.make("thread-3") };
      yield* controller!.handle(checkpointContext, {
        namespace: "research",
        tool: "create_campaign",
        callId: "call-create-checkpoint-owner",
        threadId: "provider-thread-3",
        turnId: "turn-1",
        arguments: {
          campaignId: "campaign-controller-3",
          proteusCampaignId: "C3",
        },
      });

      const response = yield* controller!.handle(checkpointContext, {
        namespace: "research",
        tool: "checkpoint",
        callId: "call-wrong-checkpoint-owner",
        threadId: "provider-thread-3",
        turnId: "turn-2",
        arguments: {
          campaignId: "campaign-controller-3",
          proteusCheckpointId: "K2",
          summary: "checkpoint",
          evidence: [],
          killedPaths: [],
          openDeviations: [],
          nextMove: "stop",
        },
      });

      assert.isFalse(response.success);
      const content = response.contentItems[0];
      assert.equal(content?.type, "inputText");
      if (content?.type === "inputText") {
        assert.include(content.text, "not linked to campaign C3");
      }
    }),
  );

  it.effect("allows a thread to replace an aborted campaign without losing its history", () =>
    Effect.gen(function* () {
      const controller = yield* ResearchToolController;
      const engine = yield* ResearchEngine;
      assert.isDefined(controller);
      const replacementContext = { ...context, threadId: ThreadId.make("thread-replacement") };

      const first = yield* controller!.handle(replacementContext, {
        namespace: "research",
        tool: "create_campaign",
        callId: "call-create-aborted",
        threadId: "provider-thread-replacement",
        turnId: "turn-1",
        arguments: {
          campaignId: "campaign-aborted",
          proteusCampaignId: "C27",
        },
      });
      const aborted = yield* controller!.handle(replacementContext, {
        namespace: "research",
        tool: "abort",
        callId: "call-abort-old",
        threadId: "provider-thread-replacement",
        turnId: "turn-2",
        arguments: {
          campaignId: "campaign-aborted",
          reason: "The linked Proteus campaign was superseded before monitoring started.",
        },
      });
      const replacement = yield* controller!.handle(replacementContext, {
        namespace: "research",
        tool: "create_campaign",
        callId: "call-create-replacement",
        threadId: "provider-thread-replacement",
        turnId: "turn-3",
        arguments: {
          campaignId: "campaign-replacement",
          proteusCampaignId: "C28",
        },
      });

      const oldProjection = yield* engine.findProjection(
        ResearchCampaignId.make("campaign-aborted"),
      );
      const currentProjection = yield* engine.findProjectionByThread(replacementContext.threadId);

      assert.isTrue(first.success);
      assert.isTrue(aborted.success);
      assert.isTrue(replacement.success);
      assert.equal(oldProjection?.campaign?.status, "aborted");
      assert.equal(currentProjection?.campaign?.id, "campaign-replacement");
      assert.equal(currentProjection?.campaign?.proteusCampaignId, "C28");
    }),
  );
});
