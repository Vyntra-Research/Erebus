import {
  OpenCode,
  type AgentInfo,
  type FormField,
  type FormInfo,
  type ModelInfo,
  type OpenCodeClient as OfficialOpenCodeClient,
  type OpenCodeEvent,
  type SessionInfo,
  type SessionMessageAssistant,
  type SessionMessageInfo,
  type SkillInfo,
} from "@opencode/client";

export interface OpenCodeModel {
  readonly id: string;
  readonly name: string;
  readonly variants?: Readonly<Record<string, unknown>>;
  readonly providerID?: string;
  readonly capabilities?: Readonly<Record<string, any>>;
}

export interface OpenCodeProviderInfo {
  readonly id: string;
  readonly name: string;
  readonly models: Readonly<Record<string, OpenCodeModel>>;
}

export interface OpenCodeProviderListResponse {
  readonly connected: ReadonlyArray<string>;
  readonly all: ReadonlyArray<OpenCodeProviderInfo>;
  readonly default: Readonly<Record<string, string>>;
}

export interface OpenCodeAgent {
  readonly id: string;
  readonly name: string;
  readonly mode: AgentInfo["mode"];
  readonly hidden: boolean;
  readonly permission: ReadonlyArray<any>;
  readonly options: Readonly<Record<string, unknown>>;
}

export interface OpenCodeSkill {
  readonly name?: string | null;
  readonly description?: string | null;
  readonly location?: string | null;
}

export interface OpenCodeFilePartInput {
  readonly type: "file";
  readonly mime: string;
  readonly filename?: string;
  readonly url: string;
}

export type OpenCodePermissionRuleset = ReadonlyArray<{
  readonly permission: string;
  readonly pattern: string;
  readonly action: "allow" | "ask" | "deny";
}>;

export interface OpenCodeQuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface OpenCodeQuestion {
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<OpenCodeQuestionOption>;
  readonly multiple?: boolean;
}

export interface OpenCodeQuestionRequest {
  readonly id: string;
  readonly sessionID: string;
  readonly questions: ReadonlyArray<OpenCodeQuestion>;
}

export type OpenCodeQuestionAnswer = ReadonlyArray<string>;

export interface OpenCodePermissionRequest {
  readonly id: string;
  readonly sessionID: string;
  readonly permission: string;
  readonly patterns: ReadonlyArray<string>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface OpenCodeTextPart {
  readonly id: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly type: "text" | "reasoning";
  readonly text: string;
  readonly time?: {
    readonly start: number;
    readonly end?: number;
  };
}

interface OpenCodeToolPart {
  readonly id: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly type: "tool";
  readonly callID: string;
  readonly tool: string;
  readonly state:
    | {
        readonly status: "pending";
        readonly input: Readonly<Record<string, unknown>>;
      }
    | {
        readonly status: "running";
        readonly input: Readonly<Record<string, unknown>>;
        readonly title?: string;
        readonly time: { readonly start: number };
      }
    | {
        readonly status: "completed";
        readonly input: Readonly<Record<string, unknown>>;
        readonly output: string;
        readonly time: { readonly start: number; readonly end: number };
      }
    | {
        readonly status: "error";
        readonly input: Readonly<Record<string, unknown>>;
        readonly error: string;
        readonly time: { readonly start: number; readonly end: number };
      };
}

export type OpenCodePart = OpenCodeTextPart | OpenCodeToolPart;

export interface OpenCodeCompatEvent {
  readonly type: string;
  readonly properties: any;
}

interface OpenCodeSessionRecord {
  readonly id: string;
  readonly title?: string;
  readonly directory?: string;
}

interface OpenCodeMessageEntry {
  readonly info: {
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly error?: unknown;
  };
  readonly parts: ReadonlyArray<OpenCodePart>;
}

export interface OpenCodeCompatClient {
  readonly provider: {
    readonly list: () => Promise<{ readonly data: OpenCodeProviderListResponse }>;
  };
  readonly app: {
    readonly agents: () => Promise<{ readonly data: ReadonlyArray<OpenCodeAgent> }>;
    readonly skills: () => Promise<{ readonly data: ReadonlyArray<OpenCodeSkill> }>;
  };
  readonly mcp: {
    readonly add: (input: {
      readonly name: string;
      readonly config: {
        readonly type: "remote";
        readonly url: string;
        readonly headers?: Readonly<Record<string, string>>;
        readonly oauth?: false;
      };
    }) => Promise<void>;
  };
  readonly event: {
    readonly subscribe: (
      input?: undefined,
      options?: { readonly signal?: AbortSignal },
    ) => Promise<{ readonly stream: AsyncIterable<OpenCodeCompatEvent> }>;
  };
  readonly session: {
    readonly create: (input: {
      readonly title?: string;
      readonly permission: OpenCodePermissionRuleset;
    }) => Promise<{ readonly data: OpenCodeSessionRecord }>;
    readonly get: (input: {
      readonly sessionID: string;
    }) => Promise<{ readonly data: OpenCodeSessionRecord }>;
    readonly update: (input: {
      readonly sessionID: string;
      readonly permission: OpenCodePermissionRuleset;
    }) => Promise<void>;
    readonly fork: (input: {
      readonly sessionID: string;
      readonly directory?: string;
    }) => Promise<{ readonly data: OpenCodeSessionRecord }>;
    readonly abort: (input: { readonly sessionID: string }) => Promise<void>;
    readonly wait: (
      input: { readonly sessionID: string },
      options?: { readonly signal?: AbortSignal },
    ) => Promise<void>;
    readonly promptAsync: (input: {
      readonly sessionID: string;
      readonly model: { readonly providerID: string; readonly modelID: string };
      readonly agent?: string;
      readonly variant?: string;
      readonly system: string;
      readonly parts: ReadonlyArray<
        { readonly type: "text"; readonly text: string } | OpenCodeFilePartInput
      >;
      readonly delivery?: "steer" | "queue";
    }) => Promise<void>;
    readonly prompt: (input: {
      readonly sessionID: string;
      readonly model: { readonly providerID: string; readonly modelID: string };
      readonly agent?: string;
      readonly variant?: string;
      readonly system?: string;
      readonly parts: ReadonlyArray<
        { readonly type: "text"; readonly text: string } | OpenCodeFilePartInput
      >;
    }) => Promise<{
      readonly data: {
        readonly info: { readonly error?: unknown };
        readonly parts: ReadonlyArray<OpenCodePart>;
      };
    }>;
    readonly messages: (input: {
      readonly sessionID: string;
    }) => Promise<{ readonly data: ReadonlyArray<OpenCodeMessageEntry> }>;
    readonly revert: (input: {
      readonly sessionID: string;
      readonly messageID?: string;
    }) => Promise<void>;
  };
  readonly permission: {
    readonly reply: (input: {
      readonly sessionID: string;
      readonly requestID: string;
      readonly reply: "once" | "always" | "reject";
    }) => Promise<void>;
  };
  readonly question: {
    readonly reply: (input: {
      readonly sessionID: string;
      readonly requestID: string;
      readonly answers: ReadonlyArray<OpenCodeQuestionAnswer>;
    }) => Promise<void>;
  };
}

export function normalizeOpenCodeApiUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed.slice(0, -4) : trimmed;
}

function toCompatSession(info: SessionInfo): OpenCodeSessionRecord {
  return {
    id: info.id,
    ...(info.title ? { title: info.title } : {}),
    directory: info.location.directory,
  };
}

function toOfficialPermissions(rules: OpenCodePermissionRuleset) {
  return rules.map((rule) => ({
    action: rule.permission,
    resource: rule.pattern,
    effect: rule.action,
  }));
}

function partId(messageID: string, kind: "text" | "reasoning", ordinal: number): string {
  return `${messageID}:${kind}:${ordinal}`;
}

function toolContentText(
  content:
    | ReadonlyArray<{ readonly type: string; readonly text?: string; readonly uri?: string }>
    | undefined,
): string {
  return (content ?? [])
    .map((item) => (item.type === "text" ? (item.text ?? "") : (item.uri ?? "")))
    .filter((value) => value.length > 0)
    .join("\n");
}

function structuredErrorText(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error ?? "OpenCode tool failed.");
}

function normalizeToolInput(value: unknown): Readonly<Record<string, unknown>> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Readonly<Record<string, unknown>>;
      }
    } catch {
      // Keep raw tool input when OpenCode emitted a non-JSON string.
    }
    return { value };
  }
  return {};
}

function toCompatAssistantParts(message: SessionMessageAssistant): ReadonlyArray<OpenCodePart> {
  return message.content.map((content, ordinal) => {
    if (content.type === "text" || content.type === "reasoning") {
      return {
        id: partId(message.id, content.type, ordinal),
        sessionID: "",
        messageID: message.id,
        type: content.type,
        text: content.text,
        time: {
          start:
            content.type === "reasoning"
              ? (content.time?.created ?? message.time.created)
              : message.time.created,
          ...(content.type === "reasoning" && content.time?.completed
            ? { end: content.time.completed }
            : message.time.completed
              ? { end: message.time.completed }
              : {}),
        },
      } satisfies OpenCodeTextPart;
    }

    const started = content.time.ran ?? content.time.created;
    const input = normalizeToolInput(content.state.input);
    if (content.state.status === "completed") {
      return {
        id: content.id,
        sessionID: "",
        messageID: message.id,
        type: "tool",
        callID: content.id,
        tool: content.name,
        state: {
          status: "completed",
          input,
          output: toolContentText(content.state.content),
          time: { start: started, end: content.time.completed ?? started },
        },
      } satisfies OpenCodeToolPart;
    }
    if (content.state.status === "error") {
      return {
        id: content.id,
        sessionID: "",
        messageID: message.id,
        type: "tool",
        callID: content.id,
        tool: content.name,
        state: {
          status: "error",
          input,
          error: structuredErrorText(content.state.error),
          time: { start: started, end: content.time.completed ?? started },
        },
      } satisfies OpenCodeToolPart;
    }
    if (content.state.status === "running") {
      return {
        id: content.id,
        sessionID: "",
        messageID: message.id,
        type: "tool",
        callID: content.id,
        tool: content.name,
        state: { status: "running", input, title: content.name, time: { start: started } },
      } satisfies OpenCodeToolPart;
    }
    return {
      id: content.id,
      sessionID: "",
      messageID: message.id,
      type: "tool",
      callID: content.id,
      tool: content.name,
      state: { status: "pending", input },
    } satisfies OpenCodeToolPart;
  });
}

function toCompatMessages(
  messages: ReadonlyArray<SessionMessageInfo>,
): ReadonlyArray<OpenCodeMessageEntry> {
  const result: Array<OpenCodeMessageEntry> = [];
  for (const message of messages) {
    if (message.type === "user") {
      result.push({ info: { id: message.id, role: "user" }, parts: [] });
    } else if (message.type === "assistant") {
      result.push({
        info: {
          id: message.id,
          role: "assistant",
          ...(message.error ? { error: message.error } : {}),
        },
        parts: toCompatAssistantParts(message),
      });
    }
  }
  return result;
}

function fieldOptions(field: FormField): ReadonlyArray<OpenCodeQuestionOption> {
  if (field.type === "string" || field.type === "multiselect") {
    return (field.options ?? []).map((option) => ({
      label: option.label,
      description: option.description ?? option.value,
    }));
  }
  if (field.type === "boolean") {
    return [
      { label: "Yes", description: "Yes" },
      { label: "No", description: "No" },
    ];
  }
  return [];
}

export function resolveOpenCodeFormOptionValue(
  options: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly description?: string;
  }>,
  value: string,
): string {
  const normalized = value.trim();
  const option = options.find(
    (candidate) =>
      candidate.value === normalized ||
      candidate.label === normalized ||
      candidate.description === normalized,
  );
  return option?.value ?? value;
}

function resolveFormOptionValue(field: FormField, value: string): string {
  if (field.type !== "string" && field.type !== "multiselect") {
    return value;
  }
  return resolveOpenCodeFormOptionValue(field.options ?? [], value);
}

function toQuestionRequest(form: FormInfo): OpenCodeQuestionRequest {
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: form.fields
      .filter((field) => field.type !== "external")
      .map((field) => ({
        header: field.title ?? field.key,
        question: field.description ?? field.title ?? field.key,
        options: fieldOptions(field),
        ...(field.type === "multiselect" ? { multiple: true } : {}),
      })),
  };
}

function toFormAnswer(form: FormInfo, answers: ReadonlyArray<OpenCodeQuestionAnswer>) {
  const answer: Record<string, string | number | boolean | ReadonlyArray<string>> = {};
  const fields = form.fields.filter((field) => field.type !== "external");
  for (const [index, field] of fields.entries()) {
    const values = answers[index] ?? [];
    const first = values[0] ?? "";
    switch (field.type) {
      case "multiselect":
        answer[field.key] = values.map((value) => resolveFormOptionValue(field, value));
        break;
      case "boolean":
        answer[field.key] = ["true", "yes", "1"].includes(first.trim().toLowerCase());
        break;
      case "number":
      case "integer": {
        const parsed = Number(first);
        answer[field.key] = Number.isFinite(parsed) ? parsed : 0;
        break;
      }
      case "string":
        answer[field.key] = resolveFormOptionValue(field, first);
        break;
    }
  }
  return answer;
}

function modelVariants(model: ModelInfo): Readonly<Record<string, unknown>> {
  return Object.fromEntries(model.variants.map((variant) => [variant.id, variant.settings ?? {}]));
}

function toProviderInventory(
  providers: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  models: ReadonlyArray<ModelInfo>,
): OpenCodeProviderListResponse {
  const byProvider = new Map<string, Record<string, OpenCodeModel>>();
  for (const model of models) {
    const bucket = byProvider.get(model.providerID) ?? {};
    bucket[model.modelID] = {
      id: model.modelID,
      name: model.name,
      variants: modelVariants(model),
    };
    byProvider.set(model.providerID, bucket);
  }
  const all = providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    models: byProvider.get(provider.id) ?? {},
  }));
  const connected = [
    ...new Set(models.filter((model) => model.enabled).map((model) => model.providerID)),
  ];
  return { connected, all, default: {} };
}

function toolEventState() {
  return new Map<
    string,
    {
      readonly sessionID: string;
      readonly messageID: string;
      readonly name: string;
      readonly started: number;
      input: Readonly<Record<string, unknown>>;
    }
  >();
}

function textEventPart(
  event: Extract<
    OpenCodeEvent,
    {
      readonly type:
        | "session.text.started"
        | "session.text.ended"
        | "session.text.delta"
        | "session.reasoning.started"
        | "session.reasoning.ended"
        | "session.reasoning.delta";
    }
  >,
  kind: "text" | "reasoning",
  text: string,
  end?: number,
): OpenCodeTextPart {
  return {
    id: partId(event.data.assistantMessageID, kind, event.data.ordinal),
    sessionID: event.data.sessionID,
    messageID: event.data.assistantMessageID,
    type: kind,
    text,
    time: { start: event.created, ...(end === undefined ? {} : { end }) },
  };
}

export async function* translateEvents(
  events: AsyncIterable<OpenCodeEvent>,
  forms: Map<string, FormInfo>,
): AsyncIterable<OpenCodeCompatEvent> {
  const tools = toolEventState();
  const activeCompactions = new Map<string, string>();
  let compactionSequence = 0;
  for await (const event of events) {
    switch (event.type) {
      case "session.renamed":
        yield {
          type: "session.updated",
          properties: { info: { id: event.data.sessionID, title: event.data.title } },
        };
        break;
      case "session.step.started":
        yield {
          type: "message.updated",
          properties: {
            sessionID: event.data.sessionID,
            info: { id: event.data.assistantMessageID, role: "assistant" },
          },
        };
        break;
      case "session.text.started":
      case "session.reasoning.started": {
        const kind = event.type === "session.text.started" ? "text" : "reasoning";
        yield {
          type: "message.part.updated",
          properties: {
            sessionID: event.data.sessionID,
            part: textEventPart(event, kind, ""),
          },
        };
        break;
      }
      case "session.text.delta":
      case "session.reasoning.delta": {
        const kind = event.type === "session.text.delta" ? "text" : "reasoning";
        yield {
          type: "message.part.delta",
          properties: {
            sessionID: event.data.sessionID,
            partID: partId(event.data.assistantMessageID, kind, event.data.ordinal),
            delta: event.data.delta,
          },
        };
        break;
      }
      case "session.text.ended":
      case "session.reasoning.ended": {
        const kind = event.type === "session.text.ended" ? "text" : "reasoning";
        yield {
          type: "message.part.updated",
          properties: {
            sessionID: event.data.sessionID,
            part: textEventPart(event, kind, event.data.text, event.created),
          },
        };
        break;
      }
      case "session.tool.input.started": {
        const tool = {
          sessionID: event.data.sessionID,
          messageID: event.data.assistantMessageID,
          name: event.data.name,
          started: event.created,
          input: {},
        };
        tools.set(event.data.id, tool);
        yield {
          type: "message.part.updated",
          properties: {
            sessionID: event.data.sessionID,
            part: {
              id: event.data.id,
              sessionID: event.data.sessionID,
              messageID: event.data.assistantMessageID,
              type: "tool",
              callID: event.data.id,
              tool: event.data.name,
              state: { status: "pending", input: {} },
            } satisfies OpenCodeToolPart,
          },
        };
        break;
      }
      case "session.tool.called": {
        const known = tools.get(event.data.id);
        const name = known?.name ?? "tool";
        const started = known?.started ?? event.created;
        const input = event.data.input;
        tools.set(event.data.id, {
          sessionID: event.data.sessionID,
          messageID: event.data.assistantMessageID,
          name,
          started,
          input,
        });
        yield {
          type: "message.part.updated",
          properties: {
            sessionID: event.data.sessionID,
            part: {
              id: event.data.id,
              sessionID: event.data.sessionID,
              messageID: event.data.assistantMessageID,
              type: "tool",
              callID: event.data.id,
              tool: name,
              state: { status: "running", input, title: name, time: { start: started } },
            } satisfies OpenCodeToolPart,
          },
        };
        break;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const known = tools.get(event.data.id);
        const name = known?.name ?? "tool";
        const started = known?.started ?? event.created;
        const input = known?.input ?? {};
        const state =
          event.type === "session.tool.success"
            ? ({
                status: "completed",
                input,
                output: toolContentText(event.data.content),
                time: { start: started, end: event.created },
              } as const)
            : ({
                status: "error",
                input,
                error: structuredErrorText(event.data.error),
                time: { start: started, end: event.created },
              } as const);
        yield {
          type: "message.part.updated",
          properties: {
            sessionID: event.data.sessionID,
            part: {
              id: event.data.id,
              sessionID: event.data.sessionID,
              messageID: event.data.assistantMessageID,
              type: "tool",
              callID: event.data.id,
              tool: name,
              state,
            } satisfies OpenCodeToolPart,
          },
        };
        tools.delete(event.data.id);
        break;
      }
      case "permission.asked":
        yield {
          type: "permission.asked",
          properties: {
            id: event.data.id,
            sessionID: event.data.sessionID,
            permission: event.data.action,
            patterns: event.data.resources,
            ...(event.data.metadata ? { metadata: event.data.metadata } : {}),
          } satisfies OpenCodePermissionRequest,
        };
        break;
      case "permission.replied":
        yield { type: "permission.replied", properties: event.data };
        break;
      case "form.created": {
        const form = event.data.form as FormInfo;
        forms.set(form.id, form);
        yield { type: "question.asked", properties: toQuestionRequest(form) };
        break;
      }
      case "form.replied": {
        const form = forms.get(event.data.id);
        const values = form
          ? form.fields
              .filter((field) => field.type !== "external")
              .map((field) => {
                const value = event.data.answer[field.key];
                return Array.isArray(value)
                  ? value.map(String)
                  : value === undefined
                    ? []
                    : [String(value)];
              })
          : [];
        forms.delete(event.data.id);
        yield {
          type: "question.replied",
          properties: {
            requestID: event.data.id,
            answers: values,
            sessionID: event.data.sessionID,
          },
        };
        break;
      }
      case "form.cancelled":
        forms.delete(event.data.id);
        yield {
          type: "question.rejected",
          properties: { requestID: event.data.id, sessionID: event.data.sessionID },
        };
        break;
      case "session.status":
        yield { type: "session.status", properties: event.data };
        break;
      case "session.compaction.started": {
        const compactionID =
          event.data.inputID ?? `${event.data.sessionID}:${compactionSequence++}`;
        activeCompactions.set(event.data.sessionID, compactionID);
        yield {
          type: "session.compaction.started",
          properties: {
            ...event.data,
            compactionID,
          },
        };
        break;
      }
      case "session.compaction.ended": {
        const compactionID =
          activeCompactions.get(event.data.sessionID) ??
          `${event.data.sessionID}:${compactionSequence++}`;
        activeCompactions.delete(event.data.sessionID);
        yield {
          type: "session.compaction.ended",
          properties: { ...event.data, compactionID },
        };
        break;
      }
      case "session.compaction.failed": {
        const compactionID =
          activeCompactions.get(event.data.sessionID) ??
          `${event.data.sessionID}:${compactionSequence++}`;
        activeCompactions.delete(event.data.sessionID);
        yield {
          type: "session.compaction.failed",
          properties: { ...event.data, compactionID },
        };
        break;
      }
      case "session.idle":
        yield {
          type: "session.status",
          properties: { sessionID: event.data.sessionID, status: { type: "idle" } },
        };
        break;
      case "session.execution.failed":
      case "session.step.failed":
        yield {
          type: "session.error",
          properties: { sessionID: event.data.sessionID, error: event.data.error },
        };
        break;
    }
  }
}

async function configurePrompt(
  client: OfficialOpenCodeClient,
  input: {
    readonly sessionID: string;
    readonly model: { readonly providerID: string; readonly modelID: string };
    readonly agent?: string;
    readonly variant?: string;
    readonly system?: string;
  },
): Promise<void> {
  await client.session.switchModel({
    sessionID: input.sessionID,
    model: {
      providerID: input.model.providerID,
      id: input.model.modelID,
      ...(input.variant ? { variant: input.variant } : {}),
    },
  });
  if (input.agent) {
    await client.session.switchAgent({ sessionID: input.sessionID, agent: input.agent });
  }
  if (input.system !== undefined) {
    await client.experimental.session.instructions.entry.put({
      sessionID: input.sessionID,
      key: "erebus.developer",
      value: input.system,
    });
  }
}

function promptContent(
  parts: ReadonlyArray<{ readonly type: "text"; readonly text: string } | OpenCodeFilePartInput>,
) {
  return {
    text: parts
      .filter(
        (part): part is { readonly type: "text"; readonly text: string } => part.type === "text",
      )
      .map((part) => part.text)
      .join("\n\n"),
    files: parts
      .filter((part): part is OpenCodeFilePartInput => part.type === "file")
      .map((part) => ({ uri: part.url, ...(part.filename ? { name: part.filename } : {}) })),
  };
}

async function listAllSessionMessages(
  client: OfficialOpenCodeClient,
  sessionID: string,
): Promise<ReadonlyArray<SessionMessageInfo>> {
  const messages: SessionMessageInfo[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const response = await client.message.list(
      cursor ? { sessionID, limit: 200, cursor } : { sessionID, order: "asc", limit: 200 },
    );
    messages.push(...response.data);
    const next = response.cursor.next ?? undefined;
    if (!next || seenCursors.has(next)) {
      return messages;
    }
    seenCursors.add(next);
    cursor = next;
  }
}

export function makeOpenCodeClient(input: {
  readonly baseUrl: string;
  readonly directory: string;
  readonly serverPassword?: string;
}): OpenCodeCompatClient {
  const headers = input.serverPassword
    ? {
        Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
      }
    : undefined;
  const client = OpenCode.make({
    baseUrl: normalizeOpenCodeApiUrl(input.baseUrl),
    ...(headers ? { headers } : {}),
  });
  const forms = new Map<string, FormInfo>();
  let locationReady: Promise<unknown> | undefined;
  const ensureLocation = () =>
    (locationReady ??= client.location.get({ location: { directory: input.directory } }));

  return {
    provider: {
      list: async () => {
        await ensureLocation();
        const [providers, models] = await Promise.all([
          client.provider.list({ location: { directory: input.directory } }),
          client.model.list({ location: { directory: input.directory }, types: ["chat"] }),
        ]);
        return { data: toProviderInventory(providers.data, models.data) };
      },
    },
    app: {
      agents: async () => {
        await ensureLocation();
        const response = await client.agent.list({ location: { directory: input.directory } });
        return {
          data: response.data.map((agent) => ({
            id: agent.id,
            name: agent.name,
            mode: agent.mode,
            hidden: agent.hidden,
            permission: agent.permissions,
            options: {},
          })),
        };
      },
      skills: async () => {
        await ensureLocation();
        const response = await client.skill.list({ location: { directory: input.directory } });
        return {
          data: response.data.map((skill: SkillInfo) => ({
            name: skill.name,
            ...(skill.description ? { description: skill.description } : {}),
            location: skill.path,
          })),
        };
      },
    },
    mcp: {
      add: async (mcp) => {
        await ensureLocation();
        await client.mcp.add({
          server: mcp.name,
          location: { directory: input.directory },
          config: mcp.config,
        });
      },
    },
    event: {
      subscribe: async (_unused, options) => ({
        stream: translateEvents(
          client.event.subscribe(options?.signal ? { signal: options.signal } : undefined),
          forms,
        ),
      }),
    },
    session: {
      create: async (session) => {
        await ensureLocation();
        return {
          data: toCompatSession(
            await client.session.create({
              ...(session.title ? { title: session.title } : {}),
              location: { directory: input.directory },
              permissions: toOfficialPermissions(session.permission),
            }),
          ),
        };
      },
      get: async ({ sessionID }) => ({
        data: toCompatSession(await client.session.get({ sessionID })),
      }),
      update: async ({ sessionID, permission }) => {
        await client.session.update({ sessionID, permissions: toOfficialPermissions(permission) });
      },
      fork: async ({ sessionID, directory }) => {
        const forked = await client.session.fork({ sessionID });
        if (directory && directory !== forked.location.directory) {
          await client.session.move({ sessionID: forked.id, directory });
          return { data: { ...toCompatSession(forked), directory } };
        }
        return { data: toCompatSession(forked) };
      },
      abort: async ({ sessionID }) => {
        await client.session.interrupt({ sessionID });
      },
      wait: async ({ sessionID }, options) => {
        await client.session.wait(
          { sessionID },
          options?.signal ? { signal: options.signal } : undefined,
        );
      },
      promptAsync: async (prompt) => {
        await configurePrompt(client, prompt);
        const content = promptContent(prompt.parts);
        await client.session.prompt({
          sessionID: prompt.sessionID,
          text: content.text,
          ...(content.files.length > 0 ? { files: content.files } : {}),
          delivery: prompt.delivery ?? "queue",
        });
      },
      prompt: async (prompt) => {
        await configurePrompt(client, prompt);
        const content = promptContent(prompt.parts);
        await client.session.prompt({
          sessionID: prompt.sessionID,
          text: content.text,
          ...(content.files.length > 0 ? { files: content.files } : {}),
          delivery: "queue",
        });
        await client.session.wait({ sessionID: prompt.sessionID });
        const response = await client.message.list({
          sessionID: prompt.sessionID,
          order: "desc",
          limit: 50,
        });
        const latestAssistant = response.data.find(
          (message): message is SessionMessageAssistant => message.type === "assistant",
        );
        return {
          data: {
            info: { ...(latestAssistant?.error ? { error: latestAssistant.error } : {}) },
            parts: latestAssistant ? toCompatAssistantParts(latestAssistant) : [],
          },
        };
      },
      messages: async ({ sessionID }) => {
        const messages = await listAllSessionMessages(client, sessionID);
        return { data: toCompatMessages(messages) };
      },
      revert: async ({ sessionID, messageID }) => {
        let target = messageID;
        if (!target) {
          const response = await client.message.list({ sessionID, order: "asc", limit: 1 });
          target = response.data[0]?.id;
        }
        if (!target) return;
        await client.session.revert.stage({ sessionID, messageID: target, files: true });
        await client.session.revert.commit({ sessionID });
      },
    },
    permission: {
      reply: ({ sessionID, requestID, reply }) =>
        client.permission.reply({ sessionID, requestID, decision: reply }),
    },
    question: {
      reply: async ({ sessionID, requestID, answers }) => {
        const form =
          forms.get(requestID) ?? (await client.session.form.get({ sessionID, formID: requestID }));
        await client.session.form.reply({
          sessionID,
          formID: requestID,
          answer: toFormAnswer(form, answers),
        });
      },
    },
  };
}
