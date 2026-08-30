import type { ResearchToolResult } from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";

export const EREBUS_RESEARCH_NAMESPACE = "research";

const objectSchema = (
  properties: Readonly<Record<string, unknown>>,
  required: ReadonlyArray<string>,
) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const nonEmptyStringSchema = { type: "string", minLength: 1 } as const;
const nonEmptyStringArraySchema = {
  type: "array",
  items: nonEmptyStringSchema,
} as const;

const findingInputSchema = objectSchema(
  {
    findingId: nonEmptyStringSchema,
    revision: { type: "integer", minimum: 1 },
    supersedesEvaluationId: {
      anyOf: [nonEmptyStringSchema, { type: "null" }],
    },
    campaignId: nonEmptyStringSchema,
    contractId: nonEmptyStringSchema,
    contractRevision: { type: "integer", minimum: 1 },
    title: nonEmptyStringSchema,
    mechanism: nonEmptyStringSchema,
    targetVersions: { type: "array", minItems: 1, items: nonEmptyStringSchema },
    attacker: nonEmptyStringSchema,
    preconditions: nonEmptyStringArraySchema,
    impact: nonEmptyStringSchema,
    cvssV31: objectSchema(
      {
        vector: nonEmptyStringSchema,
        score: { type: "number", minimum: 0, maximum: 10 },
        severity: { enum: ["none", "low", "medium", "high", "critical"] },
      },
      ["vector", "score", "severity"],
    ),
    exploitPath: { type: "array", minItems: 1, items: nonEmptyStringSchema },
    evidence: { type: "array", minItems: 1, items: nonEmptyStringSchema },
    negativeControls: nonEmptyStringArraySchema,
    duplicateCheck: nonEmptyStringSchema,
    gateClaims: {
      type: "array",
      minItems: 1,
      items: objectSchema(
        {
          gateId: nonEmptyStringSchema,
          status: { enum: ["pending", "pass", "fail", "unknown"] },
          evidence: nonEmptyStringArraySchema,
        },
        ["gateId", "status", "evidence"],
      ),
    },
    proteusBranchId: nonEmptyStringSchema,
    submittedAt: { type: "string", format: "date-time" },
  },
  [
    "findingId",
    "revision",
    "supersedesEvaluationId",
    "campaignId",
    "contractId",
    "contractRevision",
    "title",
    "mechanism",
    "targetVersions",
    "attacker",
    "preconditions",
    "impact",
    "cvssV31",
    "exploitPath",
    "evidence",
    "negativeControls",
    "duplicateCheck",
    "gateClaims",
    "proteusBranchId",
    "submittedAt",
  ],
);

const contractSchema = objectSchema(
  {
    id: nonEmptyStringSchema,
    revision: { type: "integer", minimum: 1 },
    objective: nonEmptyStringSchema,
    target: nonEmptyStringSchema,
    authorization: nonEmptyStringSchema,
    attackerModel: nonEmptyStringSchema,
    impactThreshold: nonEmptyStringSchema,
    scope: objectSchema(
      {
        included: nonEmptyStringArraySchema,
        excluded: nonEmptyStringArraySchema,
        stopConditions: nonEmptyStringArraySchema,
      },
      ["included", "excluded", "stopConditions"],
    ),
    strategy: nonEmptyStringArraySchema,
    heuristics: nonEmptyStringArraySchema,
    gates: {
      type: "array",
      minItems: 1,
      items: objectSchema(
        {
          id: nonEmptyStringSchema,
          title: nonEmptyStringSchema,
          requirement: nonEmptyStringSchema,
          required: { type: "boolean" },
        },
        ["id", "title", "requirement", "required"],
      ),
    },
    duplicatePolicy: nonEmptyStringSchema,
    labPolicy: nonEmptyStringSchema,
    reportPolicy: nonEmptyStringSchema,
    proteusCampaignId: nonEmptyStringSchema,
    createdAt: { type: "string", format: "date-time" },
  },
  [
    "id",
    "revision",
    "objective",
    "target",
    "authorization",
    "attackerModel",
    "impactThreshold",
    "scope",
    "strategy",
    "heuristics",
    "gates",
    "duplicatePolicy",
    "labPolicy",
    "reportPolicy",
    "proteusCampaignId",
    "createdAt",
  ],
);

export const EREBUS_RESEARCH_DYNAMIC_TOOL = {
  type: "namespace",
  name: EREBUS_RESEARCH_NAMESPACE,
  description:
    "Durable controls for an authorized Erebus research campaign. Use these calls instead of claiming campaign state in prose.",
  tools: [
    {
      type: "function",
      name: "create_campaign",
      description:
        "Create a durable Erebus campaign linked to the existing Proteus campaign for this project and thread.",
      inputSchema: objectSchema(
        {
          campaignId: { type: "string", minLength: 1 },
          proteusCampaignId: { type: "string", minLength: 1 },
        },
        ["campaignId", "proteusCampaignId"],
      ),
    },
    {
      type: "function",
      name: "get_status",
      description:
        "Read the durable campaign status, active contract revision, pending observer messages, findings, reviews, and queued steering.",
      inputSchema: objectSchema(
        {
          campaignId: { type: "string", minLength: 1 },
        },
        ["campaignId"],
      ),
    },
    {
      type: "function",
      name: "register_contract",
      description:
        "Register an immutable campaign contract revision before research starts or its scope changes. Exact identifier format: { campaignId, contract: { id, revision, ... } }. The nested field is contract.id; contractId belongs only to start and finding calls. Observer cadence and intervention thresholds are owned by the Erebus runtime and are not campaign fields.",
      inputSchema: objectSchema(
        {
          campaignId: { type: "string", minLength: 1 },
          contract: contractSchema,
        },
        ["campaignId", "contract"],
      ),
    },
    {
      type: "function",
      name: "start",
      description:
        "Start monitoring only after the exact registered contract revision and Proteus dependency gates are ready.",
      inputSchema: objectSchema(
        {
          campaignId: { type: "string", minLength: 1 },
          contractId: { type: "string", minLength: 1 },
          contractRevision: { type: "integer", minimum: 1 },
        },
        ["campaignId", "contractId", "contractRevision"],
      ),
    },
    {
      type: "function",
      name: "checkpoint",
      description:
        "Link a real Proteus checkpoint to a compact Erebus orchestration digest with killed paths, open deviations, and the next move. The checkpoint id may be bare (74) or use the Proteus display form (K74).",
      inputSchema: objectSchema(
        {
          campaignId: { type: "string", minLength: 1 },
          proteusCheckpointId: { type: "string", minLength: 1 },
          summary: { type: "string", minLength: 1 },
          evidence: { type: "array", items: { type: "string", minLength: 1 } },
          killedPaths: { type: "array", items: { type: "string", minLength: 1 } },
          openDeviations: { type: "array", items: { type: "string", minLength: 1 } },
          nextMove: { type: "string", minLength: 1 },
        },
        [
          "campaignId",
          "proteusCheckpointId",
          "summary",
          "evidence",
          "killedPaths",
          "openDeviations",
          "nextMove",
        ],
      ),
    },
    {
      type: "function",
      name: "pause",
      description: "Pause observer triggers and automatic steering while preserving durable state.",
      inputSchema: objectSchema({ campaignId: { type: "string", minLength: 1 } }, ["campaignId"]),
    },
    {
      type: "function",
      name: "resume",
      description:
        "Resume a paused campaign after revalidating its active contract and Proteus dependencies.",
      inputSchema: objectSchema({ campaignId: { type: "string", minLength: 1 } }, ["campaignId"]),
    },
    {
      type: "function",
      name: "finish",
      description: "Complete a campaign only when no submitted finding is awaiting judge review.",
      inputSchema: objectSchema(
        {
          campaignId: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 },
        },
        ["campaignId", "reason"],
      ),
    },
    {
      type: "function",
      name: "abort",
      description:
        "Abort monitoring without deleting the campaign, findings, evaluations, or audit history.",
      inputSchema: objectSchema(
        {
          campaignId: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 },
        },
        ["campaignId", "reason"],
      ),
    },
    {
      type: "function",
      name: "submit_finding",
      description:
        "Submit a structured finding for independent Judge review. This must be the final tool call of the current turn only when the result has accepted=true. If accepted=false, no finding or Judge job exists: correct every issue and retry research.submit_finding with the same findingId and revision. After success, end the turn instead of polling or waiting. Erebus starts a separate follow-up turn when the Judge finishes. Submission is not acceptance.",
      inputSchema: findingInputSchema,
    },
    {
      type: "function",
      name: "revise_finding",
      description:
        "Submit the next immutable revision of the same logical finding after a technical revisionRequired, rejected, or invalidSubmission verdict. Keep findingId stable, increment revision by one, and set supersedesEvaluationId to the exact latest Judge evaluation. If accepted=false, correct every issue and retry research.revise_finding with that same proposed revision; it was not recorded. Do not revise after reviewBlocked; Erebus retries that same immutable revision after evaluator recovery. This is a strict final-tool turn barrier only after accepted=true.",
      inputSchema: findingInputSchema,
    },
  ],
} satisfies CodexSchema.V2ThreadStartParams__DynamicToolSpec;

export const EREBUS_RESEARCH_TOOL_NAMES = EREBUS_RESEARCH_DYNAMIC_TOOL.tools.map(
  (tool) => tool.name,
);

export function isErebusResearchToolCall(params: CodexSchema.DynamicToolCallParams): boolean {
  return (
    params.namespace === EREBUS_RESEARCH_NAMESPACE &&
    EREBUS_RESEARCH_TOOL_NAMES.includes(params.tool)
  );
}

export function toDynamicToolResponse(
  result: ResearchToolResult,
): CodexSchema.DynamicToolCallResponse {
  return {
    success: result.accepted,
    contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
  };
}
