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
const described = <Schema extends Readonly<Record<string, unknown>>>(
  schema: Schema,
  description: string,
  examples?: ReadonlyArray<unknown>,
) => ({
  ...schema,
  description,
  ...(examples ? { examples } : {}),
});

const findingIdSchema = described(
  nonEmptyStringSchema,
  "Stable logical finding id. Keep it unchanged across reviews and revisions.",
  ["nextjs-cache-boundary-confusion"],
);
const revisionSchema = described(
  { type: "integer", minimum: 1 } as const,
  "Finding revision. Use 1 for the first submission and increment only after a durable technical verdict requests a changed artifact.",
  [1],
);

const findingInputSchema = objectSchema(
  {
    findingId: findingIdSchema,
    revision: revisionSchema,
    supersedesEvaluationId: {
      anyOf: [nonEmptyStringSchema, { type: "null" }],
      description:
        "Use null for revision 1. For a later revision, use the exact evaluation id from the prior technical verdict. A reviewBlocked retry keeps the same revision and value.",
    },
    title: described(nonEmptyStringSchema, "Concise title from the finding document."),
    target: described(
      nonEmptyStringSchema,
      "Exact product, version or ref, and deployment topology covered by the evidence.",
      ["vercel/next.js 16.3.3, self-hosted Node.js deployment"],
    ),
    findingPath: described(
      nonEmptyStringSchema,
      "Workspace-relative path to the canonical finding document under findings/. Do not create a ZIP, hash manifest, report bundle, or alternate deliverables directory.",
      ["findings/nextjs-cache-boundary-confusion.md"],
    ),
    pocPath: {
      anyOf: [nonEmptyStringSchema, { type: "null" }],
      description:
        "Workspace-relative path to the working PoC file or directory under pocs/, or null only when the finding explains why no PoC artifact applies.",
      examples: ["pocs/nextjs-cache-boundary-confusion"],
    },
  },
  ["findingId", "revision", "supersedesEvaluationId", "title", "target", "findingPath", "pocPath"],
);

export const EREBUS_RESEARCH_DYNAMIC_TOOL = {
  type: "namespace",
  name: EREBUS_RESEARCH_NAMESPACE,
  description:
    "Local CVSS calculation and campaign-free handoff to Erebus's independent finding Judge. Ordinary research needs no Erebus lifecycle calls.",
  tools: [
    {
      type: "function",
      name: "calculate_cvss",
      description:
        "Validate and calculate an explicit CVSS v3.0, v3.1, or v4.0 vector locally in Erebus. This tool never infers metrics from finding prose. Use it only after the technical impact is established; CVSS classifies a finding but never decides its validity.",
      inputSchema: objectSchema(
        {
          vector: described(
            nonEmptyStringSchema,
            "Complete CVSS:3.0, CVSS:3.1, or CVSS:4.0 vector with every required base metric.",
            ["CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:L/VA:L/SC:N/SI:N/SA:N"],
          ),
        },
        ["vector"],
      ),
    },
    {
      type: "function",
      name: "get_status",
      description:
        "Read durable Judge submissions and verdicts for this task. Pass a findingId to narrow the result, or omit it to read the latest state of every submitted finding.",
      inputSchema: objectSchema(
        {
          findingId: described(nonEmptyStringSchema, "Optional logical finding id to inspect."),
        },
        [],
      ),
    },
    {
      type: "function",
      name: "submit_finding",
      description:
        "Submit revision 1 to the independent Judge using the existing findings/ document and pocs/ artifact. If accepted=true, this must be the final tool call of the turn; Erebus delivers the durable verdict in a separate follow-up turn. If accepted=false, no Judge job exists: fix the stated input problem and retry the same revision.",
      inputSchema: findingInputSchema,
    },
    {
      type: "function",
      name: "revise_finding",
      description:
        "Submit the next artifact revision after revisionRequired, rejected, or invalidSubmission. Keep findingId stable, increment revision by one, and use the exact prior evaluation id. A reviewBlocked result is retried with the unchanged revision and unchanged artifacts instead. If accepted=true, end the turn and wait for the separate Judge follow-up.",
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
  return toDynamicToolContent(result, result.accepted);
}

export function toDynamicToolContent(
  result: unknown,
  success = true,
): CodexSchema.DynamicToolCallResponse {
  return {
    success,
    contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
  };
}
