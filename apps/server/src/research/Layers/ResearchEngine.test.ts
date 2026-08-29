import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ResearchCampaignId,
  ResearchContractId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ResearchEngine } from "../Services/ResearchEngine.ts";
import { canonicalContractDigest } from "../researchIntegrity.ts";
import { ResearchCampaignStoreLive } from "./ResearchCampaignStore.ts";
import { ResearchEngineLive } from "./ResearchEngine.ts";

const layer = it.layer(
  ResearchEngineLive.pipe(
    Layer.provideMerge(ResearchCampaignStoreLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const at = "2026-08-27T12:00:00.000Z";
const campaignId = ResearchCampaignId.make("campaign-1");

const contractRegistration = {
  id: ResearchContractId.make("contract-1"),
  revision: 1,
  objective: "Find realistic high-impact vulnerabilities.",
  target: "target",
  authorization: "Authorized research.",
  attackerModel: "Independent external attacker.",
  impactThreshold: "High",
  scope: { included: ["target"], excluded: [], stopConditions: ["out of scope"] },
  strategy: ["Map trust boundaries."],
  heuristics: ["Reject lab-assisted impact."],
  gates: [{ id: "impact", title: "Impact", requirement: "Prove High impact.", required: true }],
  duplicatePolicy: "Check Proteus and local reports.",
  labPolicy: "Use documented configuration only.",
  reportPolicy: "Require repeatable evidence.",
  observerPolicy: {
    messageWindow: 5,
    interventionConfidence: 0.8,
    cooldownMessages: 5,
    maxInterventionsPerTurn: 1,
  },
  proteusCampaignId: "proteus-1",
  createdAt: at,
} as const;
const contract = {
  ...contractRegistration,
  digest: canonicalContractDigest(contractRegistration),
};

layer("ResearchEngine", (it) => {
  it.effect("persists commands, projects state, and replays a repeated command id", () =>
    Effect.gen(function* () {
      const engine = yield* ResearchEngine;
      const sql = yield* SqlClient.SqlClient;
      const command = {
        type: "campaign.create",
        commandId: CommandId.make("tool:create:1"),
        campaignId,
        projectId: ProjectId.make("project-1"),
        principalThreadId: ThreadId.make("thread-1"),
        proteusCampaignId: "proteus-1",
        proteusRoot: "C:\\workspace",
      } as const;

      const first = yield* engine.dispatch(command);
      const repeated = yield* engine.dispatch(command);
      const rows = yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM research_events`;

      assert.isTrue(first.result.accepted);
      assert.isFalse(first.replayed);
      assert.isTrue(repeated.replayed);
      assert.equal(rows[0]?.count, 1);
      assert.equal(repeated.projection.campaign?.principalThreadId, "thread-1");
    }),
  );

  it.effect("fails closed until Proteus is ready, then activates the exact contract", () =>
    Effect.gen(function* () {
      const engine = yield* ResearchEngine;
      const secondCampaignId = ResearchCampaignId.make("campaign-2");
      yield* engine.dispatch({
        type: "campaign.create",
        commandId: CommandId.make("tool:create:2"),
        campaignId: secondCampaignId,
        projectId: ProjectId.make("project-1"),
        principalThreadId: ThreadId.make("thread-2"),
        proteusCampaignId: "proteus-1",
        proteusRoot: "C:\\workspace",
      });
      yield* engine.dispatch({
        type: "contract.register",
        commandId: CommandId.make("tool:contract:2"),
        campaignId: secondCampaignId,
        contract,
      });

      const blocked = yield* engine.dispatch({
        type: "campaign.start",
        commandId: CommandId.make("tool:start:blocked"),
        campaignId: secondCampaignId,
        contractId: contract.id,
        contractRevision: 1,
        proteusReady: false,
        dependencyIssues: ["Proteus MCP is unavailable"],
      });
      assert.isFalse(blocked.result.accepted);

      const started = yield* engine.dispatch({
        type: "campaign.start",
        commandId: CommandId.make("tool:start:ready"),
        campaignId: secondCampaignId,
        contractId: contract.id,
        contractRevision: 1,
        proteusReady: true,
        dependencyIssues: [],
      });
      assert.isTrue(started.result.accepted);
      assert.equal(started.projection.campaign?.status, "active");
      assert.equal(started.projection.campaign?.activeContractRevision, 1);
    }),
  );

  it.effect("enforces reversible pause and terminal lifecycle transitions", () =>
    Effect.gen(function* () {
      const engine = yield* ResearchEngine;
      const id = ResearchCampaignId.make("campaign-lifecycle");
      yield* engine.dispatch({
        type: "campaign.create",
        commandId: CommandId.make("lifecycle:create"),
        campaignId: id,
        projectId: ProjectId.make("project-lifecycle"),
        principalThreadId: ThreadId.make("thread-lifecycle"),
        proteusCampaignId: "proteus-1",
        proteusRoot: "C:\\workspace",
      });
      yield* engine.dispatch({
        type: "contract.register",
        commandId: CommandId.make("lifecycle:contract"),
        campaignId: id,
        contract,
      });
      yield* engine.dispatch({
        type: "campaign.start",
        commandId: CommandId.make("lifecycle:start"),
        campaignId: id,
        contractId: contract.id,
        contractRevision: 1,
        proteusReady: true,
        dependencyIssues: [],
      });

      const paused = yield* engine.dispatch({
        type: "campaign.control",
        commandId: CommandId.make("lifecycle:pause"),
        campaignId: id,
        action: "pause",
        reason: "user pause",
        proteusReady: true,
        dependencyIssues: [],
      });
      assert.equal(paused.projection.campaign?.status, "paused");

      const resumed = yield* engine.dispatch({
        type: "campaign.control",
        commandId: CommandId.make("lifecycle:resume"),
        campaignId: id,
        action: "resume",
        reason: "user resume",
        proteusReady: true,
        dependencyIssues: [],
      });
      assert.equal(resumed.projection.campaign?.status, "active");

      const completed = yield* engine.dispatch({
        type: "campaign.control",
        commandId: CommandId.make("lifecycle:finish"),
        campaignId: id,
        action: "finish",
        reason: "campaign complete",
        proteusReady: true,
        dependencyIssues: [],
      });
      assert.equal(completed.projection.campaign?.status, "completed");

      const resumeCompleted = yield* engine.dispatch({
        type: "campaign.control",
        commandId: CommandId.make("lifecycle:resume-completed"),
        campaignId: id,
        action: "resume",
        reason: "invalid resume",
        proteusReady: true,
        dependencyIssues: [],
      });
      assert.isFalse(resumeCompleted.result.accepted);
    }),
  );
});
