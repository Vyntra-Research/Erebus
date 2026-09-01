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

const described = <Schema extends Readonly<Record<string, unknown>>>(
  schema: Schema,
  description: string,
  examples?: ReadonlyArray<unknown>,
) => ({
  ...schema,
  description,
  ...(examples ? { examples } : {}),
});

const campaignIdSchema = described(
  nonEmptyStringSchema,
  "Required stable Erebus campaign id. Use the same value in every research.* call for this task.",
  ["campaign-vercel-nextjs-2026-08"],
);
const contractIdSchema = described(
  nonEmptyStringSchema,
  "Required stable contract id. In register_contract this value is nested at contract.id; later calls name it contractId.",
  ["nextjs-high-impact-contract"],
);
const contractRevisionSchema = described(
  { type: "integer", minimum: 1 } as const,
  "Required positive integer revision. Reuse the registered value until the contract changes, then increment it.",
  [7],
);
const isoDateTimeSchema = described(
  { type: "string", format: "date-time" } as const,
  "Required RFC 3339 date-time string, normally UTC with a trailing Z.",
  ["2026-08-31T22:03:34.000Z"],
);
const proteusCampaignIdSchema = described(
  nonEmptyStringSchema,
  "Required id of the existing linked Proteus campaign. A numeric id or Proteus display form such as C30 is accepted; do not use its title.",
  ["C30"],
);

const findingInputSchema = objectSchema(
  {
    findingId: described(
      nonEmptyStringSchema,
      "Required stable logical finding id. Keep it unchanged across revisions.",
      ["C30-B306-filesystem-cache-casefold"],
    ),
    revision: described(
      { type: "integer", minimum: 1 },
      "Required positive integer finding revision. Start at 1 and increment only for a persisted Judge revision.",
      [1],
    ),
    supersedesEvaluationId: {
      anyOf: [nonEmptyStringSchema, { type: "null" }],
      description:
        "Required. Use null for the first submission, or the exact Judge evaluation id superseded by a later revision.",
    },
    campaignId: campaignIdSchema,
    contractId: contractIdSchema,
    contractRevision: contractRevisionSchema,
    title: described(nonEmptyStringSchema, "Required concise finding title."),
    mechanism: described(
      nonEmptyStringSchema,
      "Required technical root mechanism, not only the observed symptom.",
    ),
    targetVersions: described(
      { type: "array", minItems: 1, items: nonEmptyStringSchema },
      "Required non-empty array of exact affected versions, refs, or deployment variants.",
      [["16.3.3"]],
    ),
    attacker: described(
      nonEmptyStringSchema,
      "Required attacker role and starting capability, consistent with the active contract.",
    ),
    preconditions: described(
      nonEmptyStringArraySchema,
      "Required array of real deployment and attacker preconditions. Use [] only when none exist.",
    ),
    impact: described(
      nonEmptyStringSchema,
      "Required practical security impact demonstrated by the evidence.",
    ),
    cvssV31: objectSchema(
      {
        vector: described(
          nonEmptyStringSchema,
          "Required canonical CVSS 3.1 vector beginning with CVSS:3.1/.",
          ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N"],
        ),
        score: described(
          { type: "number", minimum: 0, maximum: 10 },
          "Required numeric CVSS 3.1 score from 0 through 10 matching the vector.",
        ),
        severity: described(
          { enum: ["none", "low", "medium", "high", "critical"] },
          "Required lowercase CVSS severity matching the vector and score.",
        ),
      },
      ["vector", "score", "severity"],
    ),
    exploitPath: described(
      { type: "array", minItems: 1, items: nonEmptyStringSchema },
      "Required ordered, non-empty array describing the complete attacker-to-impact path.",
    ),
    evidence: described(
      { type: "array", minItems: 1, items: nonEmptyStringSchema },
      "Required non-empty array of readable evidence references or concrete observations available to the Judge.",
    ),
    negativeControls: described(
      nonEmptyStringArraySchema,
      "Required array of negative controls and their results. Use [] only when the contract permits no applicable control.",
    ),
    duplicateCheck: described(
      nonEmptyStringSchema,
      "Required summary of the Proteus and local findings/REPORTS duplicate check.",
    ),
    gateClaims: {
      type: "array",
      minItems: 1,
      items: objectSchema(
        {
          gateId: described(
            nonEmptyStringSchema,
            "Required exact gate id from the active contract.",
          ),
          status: described(
            { enum: ["pending", "pass", "fail", "unknown"] },
            "Required lowercase gate status.",
          ),
          evidence: described(
            nonEmptyStringArraySchema,
            "Required array of evidence supporting this gate status.",
          ),
        },
        ["gateId", "status", "evidence"],
      ),
    },
    proteusBranchId: described(
      nonEmptyStringSchema,
      "Required id of the linked Proteus branch. A numeric id or display form such as B306 is accepted.",
      ["B306"],
    ),
    submittedAt: isoDateTimeSchema,
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
    id: contractIdSchema,
    revision: contractRevisionSchema,
    objective: described(
      nonEmptyStringSchema,
      "Required research objective as one explicit outcome to pursue.",
    ),
    target: described(
      nonEmptyStringSchema,
      "Required plain string naming the exact product, repository or service plus the version/ref and deployment topology under test. This is contract.target, not a nested object.",
      ["vercel/next.js 16.3.3, self-hosted Node.js deployment"],
    ),
    authorization: described(
      nonEmptyStringSchema,
      "Required authorization boundary: allowed targets, environments, accounts, and prohibited actions.",
    ),
    attackerModel: described(
      nonEmptyStringSchema,
      "Required attacker starting role, access, and capabilities without lab-only help.",
    ),
    impactThreshold: described(
      nonEmptyStringSchema,
      "Required minimum practical impact needed for promotion; CVSS alone is not a threshold.",
    ),
    scope: described(
      objectSchema(
        {
          included: described(
            nonEmptyStringArraySchema,
            "Required array of in-scope surfaces and deployment conditions.",
          ),
          excluded: described(
            nonEmptyStringArraySchema,
            "Required array of excluded surfaces, impacts, and methods. Use [] only when none were defined.",
          ),
          stopConditions: described(
            nonEmptyStringArraySchema,
            "Required array of conditions that kill, pause, or pivot a branch.",
          ),
        },
        ["included", "excluded", "stopConditions"],
      ),
      "Required scope object with included, excluded, and stopConditions string arrays.",
    ),
    strategy: described(
      nonEmptyStringArraySchema,
      "Required array of campaign-level research strategies in priority order.",
    ),
    heuristics: described(
      nonEmptyStringArraySchema,
      "Required array of concrete decision heuristics used to rank, kill, or deepen branches.",
    ),
    gates: described(
      {
        type: "array",
        minItems: 1,
        items: objectSchema(
          {
            id: described(nonEmptyStringSchema, "Required stable gate id."),
            title: described(nonEmptyStringSchema, "Required short gate title."),
            requirement: described(
              nonEmptyStringSchema,
              "Required testable evidence condition for this gate.",
            ),
            required: described(
              { type: "boolean" },
              "Required boolean. true means the finding cannot pass without this gate.",
            ),
          },
          ["id", "title", "requirement", "required"],
        ),
      },
      "Required non-empty array of promotion gates.",
    ),
    duplicatePolicy: described(
      nonEmptyStringSchema,
      "Required duplicate-search and same-root handling policy.",
    ),
    labPolicy: described(
      nonEmptyStringSchema,
      "Required realism, contamination, fixture, and negative-control policy for the lab.",
    ),
    reportPolicy: described(
      nonEmptyStringSchema,
      "Required finding and final-report policy, including the evidence needed before promotion.",
    ),
    proteusCampaignId: proteusCampaignIdSchema,
    createdAt: isoDateTimeSchema,
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
          campaignId: campaignIdSchema,
          proteusCampaignId: proteusCampaignIdSchema,
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
          campaignId: campaignIdSchema,
        },
        ["campaignId"],
      ),
    },
    {
      type: "function",
      name: "register_contract",
      description:
        "Register an immutable campaign contract revision before research starts or its scope changes. Every field listed as required by the input schema must be present. Exact outer form: { campaignId: string, contract: { id: string, revision: positive integer, objective: string, target: string, authorization: string, attackerModel: string, impactThreshold: string, scope: { included: string[], excluded: string[], stopConditions: string[] }, strategy: string[], heuristics: string[], gates: [{ id: string, title: string, requirement: string, required: boolean }], duplicatePolicy: string, labPolicy: string, reportPolicy: string, proteusCampaignId: string, createdAt: RFC3339 date-time } }. target is a required plain string, not an object. The nested identifier is contract.id; contractId belongs only to start and finding calls. Observer cadence and intervention thresholds are runtime settings, not campaign fields.",
      inputSchema: objectSchema(
        {
          campaignId: campaignIdSchema,
          contract: described(
            contractSchema,
            "Required complete immutable contract object. Supply every nested field listed by this schema.",
          ),
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
          campaignId: campaignIdSchema,
          contractId: contractIdSchema,
          contractRevision: contractRevisionSchema,
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
          campaignId: campaignIdSchema,
          proteusCheckpointId: described(
            nonEmptyStringSchema,
            "Required real Proteus checkpoint id, either numeric or display form such as K74.",
            ["K74"],
          ),
          summary: described(
            nonEmptyStringSchema,
            "Required compact campaign state and contract-attestation summary.",
          ),
          evidence: described(
            nonEmptyStringArraySchema,
            "Required array of new evidence retained by this checkpoint.",
          ),
          killedPaths: described(
            nonEmptyStringArraySchema,
            "Required array of paths killed since the prior checkpoint. Use [] when none changed.",
          ),
          openDeviations: described(
            nonEmptyStringArraySchema,
            "Required array of unresolved contract deviations. Use [] when aligned.",
          ),
          nextMove: described(nonEmptyStringSchema, "Required single highest-ROI next move."),
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
      inputSchema: objectSchema({ campaignId: campaignIdSchema }, ["campaignId"]),
    },
    {
      type: "function",
      name: "resume",
      description:
        "Resume a paused campaign after revalidating its active contract and Proteus dependencies.",
      inputSchema: objectSchema({ campaignId: campaignIdSchema }, ["campaignId"]),
    },
    {
      type: "function",
      name: "finish",
      description: "Complete a campaign only when no submitted finding is awaiting judge review.",
      inputSchema: objectSchema(
        {
          campaignId: campaignIdSchema,
          reason: described(
            nonEmptyStringSchema,
            "Required concise reason for completing the campaign.",
          ),
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
          campaignId: campaignIdSchema,
          reason: described(
            nonEmptyStringSchema,
            "Required concise reason for aborting monitoring.",
          ),
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
