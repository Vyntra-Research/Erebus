import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  MessageId,
  ThreadId,
  TurnId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

const makeResearchId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const ResearchCampaignId = makeResearchId("ResearchCampaignId");
export type ResearchCampaignId = typeof ResearchCampaignId.Type;

export const ResearchContractId = makeResearchId("ResearchContractId");
export type ResearchContractId = typeof ResearchContractId.Type;

export const ResearchFindingId = makeResearchId("ResearchFindingId");
export type ResearchFindingId = typeof ResearchFindingId.Type;

export const ResearchEvaluationId = makeResearchId("ResearchEvaluationId");
export type ResearchEvaluationId = typeof ResearchEvaluationId.Type;

export const ResearchInterventionId = makeResearchId("ResearchInterventionId");
export type ResearchInterventionId = typeof ResearchInterventionId.Type;

export const ResearchEventId = makeResearchId("ResearchEventId");
export type ResearchEventId = typeof ResearchEventId.Type;

export const ResearchCampaignStatus = Schema.Literals([
  "draft",
  "ready",
  "active",
  "paused",
  "blockedDependency",
  "recovering",
  "finishing",
  "completed",
  "aborted",
]);
export type ResearchCampaignStatus = typeof ResearchCampaignStatus.Type;

export const ResearchGateStatus = Schema.Literals(["pending", "pass", "fail", "unknown"]);
export type ResearchGateStatus = typeof ResearchGateStatus.Type;

export const ResearchContractGate = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  requirement: TrimmedNonEmptyString,
  required: Schema.Boolean,
});
export type ResearchContractGate = typeof ResearchContractGate.Type;

export const ResearchContractScope = Schema.Struct({
  included: Schema.Array(TrimmedNonEmptyString),
  excluded: Schema.Array(TrimmedNonEmptyString),
  stopConditions: Schema.Array(TrimmedNonEmptyString),
});
export type ResearchContractScope = typeof ResearchContractScope.Type;

export const ResearchObserverPolicy = Schema.Struct({
  messageWindow: PositiveInt,
  interventionConfidence: Schema.Number.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(1),
  ),
  cooldownMessages: NonNegativeInt,
  maxInterventionsPerTurn: Schema.NullOr(PositiveInt),
});
export type ResearchObserverPolicy = typeof ResearchObserverPolicy.Type;

const ResearchContractRegistrationFields = {
  id: ResearchContractId,
  revision: PositiveInt,
  objective: TrimmedNonEmptyString,
  target: TrimmedNonEmptyString,
  authorization: TrimmedNonEmptyString,
  attackerModel: TrimmedNonEmptyString,
  impactThreshold: TrimmedNonEmptyString,
  scope: ResearchContractScope,
  strategy: Schema.Array(TrimmedNonEmptyString),
  heuristics: Schema.Array(TrimmedNonEmptyString),
  gates: Schema.Array(ResearchContractGate).check(Schema.isMinLength(1)),
  duplicatePolicy: TrimmedNonEmptyString,
  labPolicy: TrimmedNonEmptyString,
  reportPolicy: TrimmedNonEmptyString,
  proteusCampaignId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
} as const;

export const ResearchContractRegistration = Schema.Struct(ResearchContractRegistrationFields);
export type ResearchContractRegistration = typeof ResearchContractRegistration.Type;

export const ResearchContract = Schema.Struct({
  ...ResearchContractRegistrationFields,
  observerPolicy: ResearchObserverPolicy,
  digest: TrimmedNonEmptyString,
});
export type ResearchContract = typeof ResearchContract.Type;

export const ResearchDependencyState = Schema.Literals([
  "unknown",
  "ready",
  "missing",
  "incompatible",
  "failed",
]);
export type ResearchDependencyState = typeof ResearchDependencyState.Type;

export const ResearchProteusHealth = Schema.Struct({
  runtime: ResearchDependencyState,
  plugin: ResearchDependencyState,
  skills: ResearchDependencyState,
  mcp: ResearchDependencyState,
  version: Schema.NullOr(TrimmedNonEmptyString),
  message: Schema.NullOr(TrimmedNonEmptyString),
  checkedAt: IsoDateTime,
});
export type ResearchProteusHealth = typeof ResearchProteusHealth.Type;

export const ResearchCampaign = Schema.Struct({
  id: ResearchCampaignId,
  projectId: ProjectId,
  principalThreadId: ThreadId,
  observerThreadId: Schema.NullOr(ThreadId),
  judgeThreadId: Schema.NullOr(ThreadId),
  proteusCampaignId: TrimmedNonEmptyString,
  proteusRoot: Schema.optionalKey(TrimmedNonEmptyString),
  activeContractId: Schema.NullOr(ResearchContractId),
  activeContractRevision: Schema.NullOr(PositiveInt),
  status: ResearchCampaignStatus,
  eligibleMessageCount: NonNegativeInt,
  lastObservedMessageCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ResearchCampaign = typeof ResearchCampaign.Type;

export const ResearchFindingGateClaim = Schema.Struct({
  gateId: TrimmedNonEmptyString,
  status: ResearchGateStatus,
  evidence: Schema.Array(TrimmedNonEmptyString),
});
export type ResearchFindingGateClaim = typeof ResearchFindingGateClaim.Type;

export const ResearchCvssSeverity = Schema.Literals(["none", "low", "medium", "high", "critical"]);
export type ResearchCvssSeverity = typeof ResearchCvssSeverity.Type;

export const ResearchCvssV31 = Schema.Struct({
  vector: TrimmedNonEmptyString,
  score: Schema.Number.check(Schema.isFinite()),
  severity: ResearchCvssSeverity,
});
export type ResearchCvssV31 = typeof ResearchCvssV31.Type;

export const ResearchFindingSubmission = Schema.Struct({
  findingId: ResearchFindingId,
  revision: Schema.optional(PositiveInt),
  supersedesEvaluationId: Schema.optional(Schema.NullOr(ResearchEvaluationId)),
  campaignId: ResearchCampaignId,
  contractId: ResearchContractId,
  contractRevision: PositiveInt,
  title: TrimmedNonEmptyString,
  mechanism: TrimmedNonEmptyString,
  targetVersions: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  attacker: TrimmedNonEmptyString,
  preconditions: Schema.Array(TrimmedNonEmptyString),
  impact: TrimmedNonEmptyString,
  cvssV31: Schema.optional(ResearchCvssV31),
  exploitPath: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  evidence: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  negativeControls: Schema.Array(TrimmedNonEmptyString),
  duplicateCheck: TrimmedNonEmptyString,
  gateClaims: Schema.Array(ResearchFindingGateClaim).check(Schema.isMinLength(1)),
  proteusBranchId: TrimmedNonEmptyString,
  submittedAt: IsoDateTime,
});
export type ResearchFindingSubmission = typeof ResearchFindingSubmission.Type;

export const ResearchObserverVerdict = Schema.Literals([
  "aligned",
  "watch",
  "deviation",
  "criticalDeviation",
]);
export type ResearchObserverVerdict = typeof ResearchObserverVerdict.Type;

export const ResearchObserverEvaluation = Schema.Struct({
  evaluationId: ResearchEvaluationId,
  campaignId: ResearchCampaignId,
  observedThreadId: Schema.optionalKey(ThreadId),
  contractId: ResearchContractId,
  contractRevision: PositiveInt,
  messageItemIds: Schema.Array(MessageId).check(Schema.isMinLength(1)),
  verdict: ResearchObserverVerdict,
  confidence: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  contractClauses: Schema.Array(TrimmedNonEmptyString),
  evidence: Schema.Array(TrimmedNonEmptyString),
  risk: Schema.NullOr(TrimmedNonEmptyString),
  recommendedSteering: Schema.NullOr(TrimmedNonEmptyString),
  runtime: Schema.Struct({
    policyVersion: PositiveInt,
    policyDigest: TrimmedNonEmptyString,
    model: TrimmedNonEmptyString,
    reasoningEffort: TrimmedNonEmptyString,
  }),
  evaluatedAt: IsoDateTime,
});
export type ResearchObserverEvaluation = typeof ResearchObserverEvaluation.Type;

export const ResearchJudgeVerdict = Schema.Literals([
  "accepted",
  "revisionRequired",
  "rejected",
  "invalidSubmission",
  "reviewBlocked",
]);
export type ResearchJudgeVerdict = typeof ResearchJudgeVerdict.Type;

export const ResearchGateDecision = Schema.Struct({
  gateId: TrimmedNonEmptyString,
  status: ResearchGateStatus,
  reason: TrimmedNonEmptyString,
  evidence: Schema.Array(TrimmedNonEmptyString),
});
export type ResearchGateDecision = typeof ResearchGateDecision.Type;

export const ResearchJudgeEvaluation = Schema.Struct({
  evaluationId: ResearchEvaluationId,
  findingId: ResearchFindingId,
  findingRevision: Schema.optional(PositiveInt),
  campaignId: ResearchCampaignId,
  contractId: ResearchContractId,
  contractRevision: PositiveInt,
  verdict: ResearchJudgeVerdict,
  confidence: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  gates: Schema.Array(ResearchGateDecision).check(Schema.isMinLength(1)),
  summary: TrimmedNonEmptyString,
  nextAction: Schema.NullOr(TrimmedNonEmptyString),
  cvssV31: Schema.optional(Schema.NullOr(ResearchCvssV31)),
  runtime: Schema.Struct({
    policyVersion: PositiveInt,
    policyDigest: TrimmedNonEmptyString,
    model: TrimmedNonEmptyString,
    reasoningEffort: TrimmedNonEmptyString,
  }),
  evaluatedAt: IsoDateTime,
});
export type ResearchJudgeEvaluation = typeof ResearchJudgeEvaluation.Type;

export const ResearchInterventionStatus = Schema.Literals([
  "queued",
  "queuedWhilePaused",
  "delivered",
  "failed",
  "superseded",
]);
export type ResearchInterventionStatus = typeof ResearchInterventionStatus.Type;

export const ResearchInterventionSource = Schema.Literals(["observer", "judge"]);
export type ResearchInterventionSource = typeof ResearchInterventionSource.Type;

export const ResearchInterventionDelivery = Schema.Literals(["live", "historical", "followUp"]);
export type ResearchInterventionDelivery = typeof ResearchInterventionDelivery.Type;

export const ResearchIntervention = Schema.Struct({
  id: ResearchInterventionId,
  campaignId: ResearchCampaignId,
  evaluationId: ResearchEvaluationId,
  targetThreadId: Schema.optionalKey(ThreadId),
  source: ResearchInterventionSource,
  delivery: ResearchInterventionDelivery,
  status: ResearchInterventionStatus,
  observation: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  expectedTurnId: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  deliveredAt: Schema.NullOr(IsoDateTime),
});
export type ResearchIntervention = typeof ResearchIntervention.Type;

export const ResearchRegisterContractInput = Schema.Struct({
  campaignId: ResearchCampaignId,
  contract: ResearchContractRegistration,
});
export type ResearchRegisterContractInput = typeof ResearchRegisterContractInput.Type;

export const ResearchCreateCampaignInput = Schema.Struct({
  campaignId: ResearchCampaignId,
  proteusCampaignId: TrimmedNonEmptyString,
});
export type ResearchCreateCampaignInput = typeof ResearchCreateCampaignInput.Type;

export const ResearchCampaignRefInput = Schema.Struct({
  campaignId: ResearchCampaignId,
});
export type ResearchCampaignRefInput = typeof ResearchCampaignRefInput.Type;

export const ResearchCampaignCloseInput = Schema.Struct({
  campaignId: ResearchCampaignId,
  reason: TrimmedNonEmptyString,
});
export type ResearchCampaignCloseInput = typeof ResearchCampaignCloseInput.Type;

export const ResearchStartInput = Schema.Struct({
  campaignId: ResearchCampaignId,
  contractId: ResearchContractId,
  contractRevision: PositiveInt,
});
export type ResearchStartInput = typeof ResearchStartInput.Type;

export const ResearchCheckpointInput = Schema.Struct({
  campaignId: ResearchCampaignId,
  proteusCheckpointId: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  evidence: Schema.Array(TrimmedNonEmptyString),
  killedPaths: Schema.Array(TrimmedNonEmptyString),
  openDeviations: Schema.Array(TrimmedNonEmptyString),
  nextMove: TrimmedNonEmptyString,
});
export type ResearchCheckpointInput = typeof ResearchCheckpointInput.Type;

export const ResearchSubmitFindingInput = ResearchFindingSubmission;
export type ResearchSubmitFindingInput = typeof ResearchSubmitFindingInput.Type;

export const ResearchToolResult = Schema.Struct({
  accepted: Schema.Boolean,
  status: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  issues: Schema.Array(TrimmedNonEmptyString),
  retry: Schema.optional(
    Schema.Struct({
      required: Schema.Boolean,
      tool: Schema.Literals(["research.submit_finding", "research.revise_finding"]),
      mode: Schema.Literal("sameFindingRevision"),
      instruction: TrimmedNonEmptyString,
    }),
  ),
});
export type ResearchToolResult = typeof ResearchToolResult.Type;

export const ResearchInternalPolicy = Schema.Struct({
  version: PositiveInt,
  digest: TrimmedNonEmptyString,
  principalInstructions: TrimmedNonEmptyString,
  observerInstructions: TrimmedNonEmptyString,
  judgeInstructions: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});
export type ResearchInternalPolicy = typeof ResearchInternalPolicy.Type;

export const ResearchControlMessage = Schema.Struct({
  source: Schema.Literals(["observer", "judge", "recovery"]),
  campaignId: ResearchCampaignId,
  evaluationId: Schema.NullOr(ResearchEvaluationId),
  contractRevision: PositiveInt,
  text: TrimmedNonEmptyString,
  dedupeKey: TrimmedNonEmptyString,
});
export type ResearchControlMessage = typeof ResearchControlMessage.Type;

export const ResearchPrincipalMessage = Schema.Struct({
  id: MessageId,
  text: Schema.String,
  turnId: Schema.NullOr(TurnId),
});
export type ResearchPrincipalMessage = typeof ResearchPrincipalMessage.Type;

export const ResearchContractDraft = Schema.Struct({
  objective: TrimmedString,
  target: TrimmedString,
  authorization: TrimmedString,
  attackerModel: TrimmedString,
  impactThreshold: TrimmedString,
  scope: ResearchContractScope,
  strategy: Schema.Array(TrimmedNonEmptyString),
  heuristics: Schema.Array(TrimmedNonEmptyString),
  gates: Schema.Array(ResearchContractGate),
  duplicatePolicy: TrimmedString,
  labPolicy: TrimmedString,
  reportPolicy: TrimmedString,
  proteusCampaignId: TrimmedString,
});
export type ResearchContractDraft = typeof ResearchContractDraft.Type;

const ResearchEventEnvelope = {
  eventId: ResearchEventId,
  campaignId: ResearchCampaignId,
  sequence: PositiveInt,
  recordedAt: IsoDateTime,
} as const;

export const ResearchEvent = Schema.Union([
  Schema.Struct({
    ...ResearchEventEnvelope,
    type: Schema.Literal("campaign.created"),
    campaign: ResearchCampaign,
  }),
  Schema.Struct({
    ...ResearchEventEnvelope,
    type: Schema.Literal("contract.registered"),
    contract: ResearchContract,
  }),
  Schema.Struct({
    ...ResearchEventEnvelope,
    type: Schema.Literal("contract.activated"),
    contractId: ResearchContractId,
    contractRevision: PositiveInt,
  }),
  Schema.Struct({
    ...ResearchEventEnvelope,
    type: Schema.Literal("campaign.started"),
    contractId: ResearchContractId,
    contractRevision: PositiveInt,
  }),
  Schema.Struct({
    ...ResearchEventEnvelope,
    type: Schema.Literal("campaign.statusChanged"),
    status: ResearchCampaignStatus,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...ResearchEventEnvelope,
    type: Schema.Literal("principal.messageCompleted"),
    messageItemId: MessageId,
    text: Schema.String,
    turnId: Schema.NullOr(TurnId),
  }),
  Schema.Struct({
    ...ResearchEventEnvelope,
    type: Schema.Literal("observer.evaluationRecorded"),
    evaluation: ResearchObserverEvaluation,
    windowEndMessageCount: PositiveInt,
  }),
  Schema.Struct({
    ...ResearchEventEnvelope,
    type: Schema.Literal("finding.submitted"),
    finding: ResearchFindingSubmission,
  }),
  Schema.Struct({
    ...ResearchEventEnvelope,
    type: Schema.Literal("judge.evaluationRecorded"),
    evaluation: ResearchJudgeEvaluation,
  }),
  Schema.Struct({
    ...ResearchEventEnvelope,
    type: Schema.Literal("intervention.recorded"),
    intervention: ResearchIntervention,
  }),
  Schema.Struct({
    ...ResearchEventEnvelope,
    type: Schema.Literal("checkpoint.recorded"),
    checkpoint: ResearchCheckpointInput,
  }),
]);
export type ResearchEvent = typeof ResearchEvent.Type;
