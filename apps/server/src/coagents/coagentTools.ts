import type * as CodexSchema from "effect-codex-app-server/schema";

export const EREBUS_THREADS_NAMESPACE = "threads";

const objectSchema = (
  properties: Readonly<Record<string, unknown>>,
  required: ReadonlyArray<string>,
) => ({ type: "object", properties, required, additionalProperties: false });

const nonEmptyString = { type: "string", minLength: 1 } as const;
const threadId = {
  ...nonEmptyString,
  description: "Exact Erebus task id returned by threads.list or threads.spawn.",
} as const;

export const EREBUS_THREADS_DYNAMIC_TOOL = {
  type: "namespace",
  name: EREBUS_THREADS_NAMESPACE,
  description:
    "Durable task coordination for bounded horizontal work. Co-agent tasks cannot spawn more co-agent tasks.",
  tools: [
    {
      type: "function",
      name: "list",
      description:
        "List either this task's direct co-agents or the active tasks in the same Erebus project.",
      inputSchema: objectSchema(
        {
          scope: {
            enum: ["children", "project"],
            description: "children lists managed co-agents; project lists active peer tasks.",
          },
        },
        ["scope"],
      ),
    },
    {
      type: "function",
      name: "read",
      description:
        "Read a bounded recent transcript from an active task in the same project. Use this for coordination, not bulk context copying.",
      inputSchema: objectSchema(
        {
          threadId,
          messageLimit: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            description: "Maximum recent user and assistant messages to return.",
          },
        },
        ["threadId"],
      ),
    },
    {
      type: "function",
      name: "spawn",
      description:
        "Create one direct co-agent task and start its bounded assignment. blank starts with only the assignment and coordination contract; fork also includes a bounded copy of recent completed parent context. The child inherits project, workspace, model, effort/runtime, interaction mode, and Erebus integrations. At most four direct co-agents may exist for one parent.",
      inputSchema: objectSchema(
        {
          mode: {
            enum: ["blank", "fork"],
            description: "Use fork only when the recent parent conversation is required.",
          },
          title: {
            ...nonEmptyString,
            maxLength: 120,
            description: "Short task title visible in the Erebus sidebar.",
          },
          task: {
            ...nonEmptyString,
            maxLength: 12_000,
            description:
              "Concrete bounded assignment, expected output, relevant constraints, and stop condition.",
          },
        },
        ["mode", "title", "task"],
      ),
    },
    {
      type: "function",
      name: "send",
      description:
        "Send an explicit follow-up to another active task in the same project. A co-agent may send only to its parent; a principal may send to project peers or its children.",
      inputSchema: objectSchema(
        {
          threadId,
          message: {
            ...nonEmptyString,
            maxLength: 12_000,
            description: "Complete follow-up instruction or result message.",
          },
        },
        ["threadId", "message"],
      ),
    },
    {
      type: "function",
      name: "interrupt",
      description:
        "Interrupt a running direct co-agent task. This is a recovery control, not a routine way to redirect valid work.",
      inputSchema: objectSchema({ threadId }, ["threadId"]),
    },
    {
      type: "function",
      name: "wait",
      description:
        "Wait for one of the specified direct co-agent tasks to stop running. The wait is bounded and returns a fresh snapshot plus the latest completed assistant response as the canonical handback when available.",
      inputSchema: objectSchema(
        {
          threadIds: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            uniqueItems: true,
            items: threadId,
          },
          timeoutMs: {
            type: "integer",
            minimum: 0,
            maximum: 60_000,
            description: "Maximum event wait. Use 0 for an immediate snapshot.",
          },
        },
        ["threadIds"],
      ),
    },
    {
      type: "function",
      name: "release",
      description:
        "Archive one completed direct co-agent after its final result has been read and collected. This frees one co-agent slot while preserving the task as an audit trail. Running tasks must be interrupted and settled first.",
      inputSchema: objectSchema({ threadId }, ["threadId"]),
    },
  ],
} satisfies CodexSchema.V2ThreadStartParams__DynamicToolSpec;

const names = new Set(EREBUS_THREADS_DYNAMIC_TOOL.tools.map((tool) => tool.name));

export function isErebusThreadsToolCall(params: CodexSchema.DynamicToolCallParams): boolean {
  return params.namespace === EREBUS_THREADS_NAMESPACE && names.has(params.tool);
}
