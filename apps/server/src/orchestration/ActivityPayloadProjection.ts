import type {
  OrchestrationEvent,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const ACTIVITY_SUMMARY_CHARACTER_LIMIT = 512;
const ACTIVITY_DETAIL_CHARACTER_LIMIT = 8 * 1024;
const TOOL_VALUE_CHARACTER_BUDGET = 32 * 1024;
const TOOL_VALUE_STRING_LIMIT = 16 * 1024;
const TOOL_VALUE_COLLECTION_LIMIT = 128;
const TOOL_VALUE_DEPTH_LIMIT = 8;
const TOOL_VALUE_TRAVERSAL_LIMIT = 512;
const TOOL_VALUE_MIN_JSON_LENGTH = 4;
const TOOL_VALUE_TRUNCATED = "[truncated]";

interface ToolValueBudget {
  remaining: number;
  readonly seen: WeakSet<object>;
}

interface ToolValueTraversalBudget {
  remaining: number;
}

function truncateActivityText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Tool inputs are useful UI context but are not canonical conversation data.
 * Keep their JSON shape for ordinary values while putting a hard ceiling on a
 * single activity crossing HTTP/WS. The canonical provider event remains in
 * persistence; only the client projection is bounded.
 */
function consumeToolValueBudget(budget: ToolValueBudget, length: number): boolean {
  if (length > budget.remaining) {
    return false;
  }
  budget.remaining -= length;
  return true;
}

function projectBoundedToolString(
  value: string,
  budget: ToolValueBudget,
  characterLimit = TOOL_VALUE_STRING_LIMIT,
): string | null {
  const maxPrefixLength = Math.min(
    value.length,
    Math.max(0, characterLimit - (value.length > characterLimit ? 1 : 0)),
  );
  const makeCandidate = (prefixLength: number) =>
    prefixLength < value.length ? `${value.slice(0, prefixLength)}…` : value;

  let low = 0;
  let high = maxPrefixLength;
  let projected: string | null = null;
  let projectedLength = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = makeCandidate(middle);
    const candidateLength = JSON.stringify(candidate).length;
    if (candidateLength <= budget.remaining) {
      projected = candidate;
      projectedLength = candidateLength;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (projected === null) {
    consumeToolValueBudget(budget, TOOL_VALUE_MIN_JSON_LENGTH);
    return null;
  }
  consumeToolValueBudget(budget, projectedLength);
  return projected;
}

function projectBoundedToolMarker(marker: string, budget: ToolValueBudget): string | null {
  const encodedLength = JSON.stringify(marker).length;
  if (consumeToolValueBudget(budget, encodedLength)) {
    return marker;
  }
  consumeToolValueBudget(budget, TOOL_VALUE_MIN_JSON_LENGTH);
  return null;
}

function projectBoundedToolValue(value: unknown, budget: ToolValueBudget, depth = 0): unknown {
  if (typeof value === "string") {
    return projectBoundedToolString(value, budget);
  }
  if (value === null || typeof value === "undefined") {
    consumeToolValueBudget(budget, TOOL_VALUE_MIN_JSON_LENGTH);
    return null;
  }
  if (typeof value === "number") {
    const projected = Number.isFinite(value) ? value : null;
    if (consumeToolValueBudget(budget, JSON.stringify(projected).length)) {
      return projected;
    }
    consumeToolValueBudget(budget, TOOL_VALUE_MIN_JSON_LENGTH);
    return null;
  }
  if (typeof value === "boolean") {
    if (consumeToolValueBudget(budget, value ? 4 : 5)) {
      return value;
    }
    consumeToolValueBudget(budget, TOOL_VALUE_MIN_JSON_LENGTH);
    return null;
  }
  if (typeof value !== "object") {
    return projectBoundedToolString(String(value), budget, 256);
  }
  if (depth >= TOOL_VALUE_DEPTH_LIMIT || budget.remaining < TOOL_VALUE_MIN_JSON_LENGTH) {
    return projectBoundedToolMarker(TOOL_VALUE_TRUNCATED, budget);
  }
  if (budget.seen.has(value)) {
    return projectBoundedToolMarker("[circular]", budget);
  }

  budget.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (!consumeToolValueBudget(budget, 2)) {
        return null;
      }
      const projected: unknown[] = [];
      const length = Math.min(value.length, TOOL_VALUE_COLLECTION_LIMIT);
      for (let index = 0; index < length; index += 1) {
        const separatorLength = projected.length === 0 ? 0 : 1;
        if (budget.remaining < separatorLength + TOOL_VALUE_MIN_JSON_LENGTH) {
          break;
        }
        consumeToolValueBudget(budget, separatorLength);
        projected.push(projectBoundedToolValue(value[index], budget, depth + 1));
      }
      if (value.length > projected.length) {
        const marker = `[${value.length - projected.length} more items]`;
        const separatorLength = projected.length === 0 ? 0 : 1;
        const markerLength = JSON.stringify(marker).length;
        if (consumeToolValueBudget(budget, separatorLength + markerLength)) {
          projected.push(marker);
        }
      }
      return projected;
    }

    if (!consumeToolValueBudget(budget, 2)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    let count = 0;
    let truncated = false;
    for (const key in record) {
      if (!Object.hasOwn(record, key)) {
        continue;
      }
      if (count >= TOOL_VALUE_COLLECTION_LIMIT) {
        truncated = true;
        break;
      }
      const separatorLength = count === 0 ? 0 : 1;
      if (key.length + separatorLength + 3 + TOOL_VALUE_MIN_JSON_LENGTH > budget.remaining) {
        truncated = true;
        break;
      }
      const keyLength = JSON.stringify(key).length;
      const propertyPrefixLength = separatorLength + keyLength + 1;
      if (propertyPrefixLength + TOOL_VALUE_MIN_JSON_LENGTH > budget.remaining) {
        truncated = true;
        break;
      }
      consumeToolValueBudget(budget, propertyPrefixLength);
      projected[key] = projectBoundedToolValue(record[key], budget, depth + 1);
      count += 1;
    }
    if (truncated && !Object.hasOwn(projected, "_truncated")) {
      const separatorLength = count === 0 ? 0 : 1;
      const markerLength = separatorLength + JSON.stringify("_truncated").length + 1 + 4;
      if (consumeToolValueBudget(budget, markerLength)) {
        projected._truncated = true;
      }
    }
    return projected;
  } finally {
    budget.seen.delete(value);
  }
}

function makeToolValueBudget(): ToolValueBudget {
  return { remaining: TOOL_VALUE_CHARACTER_BUDGET, seen: new WeakSet<object>() };
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown): void {
  const normalized = asTrimmedString(value);
  if (!normalized) {
    return;
  }
  const projected = truncateActivityText(normalized, 1024);
  if (seen.has(projected)) {
    return;
  }
  seen.add(projected);
  target.push(projected);
}

function collectChangedFiles(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number,
  traversal: ToolValueTraversalBudget = { remaining: TOOL_VALUE_TRAVERSAL_LIMIT },
): void {
  if (depth > 4 || target.length >= 12 || traversal.remaining <= 0) {
    return;
  }
  traversal.remaining -= 1;
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1, traversal);
      if (target.length >= 12 || traversal.remaining <= 0) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1, traversal);
    if (target.length >= 12 || traversal.remaining <= 0) {
      return;
    }
  }
}

function projectCommandData(
  data: Record<string, unknown>,
  budget: ToolValueBudget,
): Record<string, unknown> | undefined {
  const item = asRecord(data.item);
  if (!item) {
    return undefined;
  }

  const projectedItem: Record<string, unknown> = {};
  if ("command" in item) {
    projectedItem.command = projectBoundedToolValue(item.command, budget);
  }

  const aggregatedOutput = asTrimmedString(item.aggregatedOutput);
  if (aggregatedOutput) {
    const summary = summarizeToolTextOutput(aggregatedOutput);
    if (summary) {
      projectedItem.aggregatedOutput = summary;
    }
  }

  const input = asRecord(item.input);
  if (input && "command" in input) {
    projectedItem.input = { command: projectBoundedToolValue(input.command, budget) };
  }

  const result = asRecord(item.result);
  if (result) {
    const projectedResult: Record<string, unknown> = {};
    if ("command" in result) {
      projectedResult.command = projectBoundedToolValue(result.command, budget);
    }
    const content = asTrimmedString(result.content);
    if (content) {
      const summary = summarizeToolTextOutput(content);
      if (summary) {
        projectedResult.content = summary;
      }
    }
    if (Object.keys(projectedResult).length > 0) {
      projectedItem.result = projectedResult;
    }
  }

  return Object.keys(projectedItem).length > 0 ? projectedItem : undefined;
}

function projectCommandValue(data: Record<string, unknown>): unknown {
  if (data.command !== undefined) {
    return data.command;
  }

  const input = asRecord(data.input);
  if (input?.command !== undefined) {
    return input.command;
  }

  const stateInput = asRecord(asRecord(data.state)?.input);
  if (stateInput?.command !== undefined) {
    return stateInput.command;
  }

  return undefined;
}

function summarizeToolTextOutput(value: string): string | null {
  const limit = 84;
  let line = "";
  let pendingSpace = false;
  let nonEmptyLines = 0;

  const finishLine = (): string | null => {
    pendingSpace = false;
    if (line.length === 0) {
      return null;
    }
    nonEmptyLines += 1;
    if (line === "```") {
      line = "";
      return null;
    }
    return line;
  };

  // Build only the first renderable line instead of splitting or normalizing
  // the complete output. Tool results can be megabytes long, while the UI
  // renders at most 84 characters from this non-canonical preview.
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "\n") {
      const completed = finishLine();
      if (completed !== null) {
        return completed;
      }
      continue;
    }
    if (/\s/u.test(character)) {
      if (line.length > 0) {
        pendingSpace = true;
      }
      continue;
    }
    if (pendingSpace) {
      line += " ";
      pendingSpace = false;
    }
    line += character;
    if (line.length > limit) {
      return `${line.slice(0, limit - 1).trimEnd()}…`;
    }
  }

  const completed = finishLine();
  if (completed !== null) {
    return completed;
  }
  return nonEmptyLines > 1 ? `${nonEmptyLines.toLocaleString()} lines` : null;
}

/**
 * Fields of an MCP tool-call item both clients render in the expanded
 * work-log row. Everything else — notably `result`, which carries the full
 * tool output and dominates wire size on MCP-heavy threads — is summarized
 * or dropped. Full payloads remain in persistence.
 */
const MCP_ITEM_KEPT_FIELDS = [
  "type",
  "id",
  "tool",
  "server",
  "status",
  "arguments",
  "appContext",
  "error",
  "durationMs",
] as const;

/**
 * Pulls renderable text out of an MCP tool result: either a Codex-style
 * `{content: [{type: "text", text}, ...]}` record or a raw Claude
 * `tool_result` block whose `content` is a string or block array.
 */
function summarizeMcpResultText(result: unknown): string | null {
  const record = asRecord(result);
  if (!record) {
    return typeof result === "string" ? summarizeToolTextOutput(result) : null;
  }
  if (typeof record.content === "string") {
    return summarizeToolTextOutput(record.content);
  }
  if (Array.isArray(record.content)) {
    for (const entry of record.content) {
      const text = asRecord(entry)?.text;
      if (typeof text === "string") {
        const summary = summarizeToolTextOutput(text);
        if (summary !== null) {
          return summary;
        }
      }
    }
  }
  return null;
}

function summarizeMcpResult(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }
  const summary = summarizeMcpResultText(result);
  return summary ? { content: summary } : undefined;
}

/**
 * MCP tool calls carry full tool results (`data.item.result` on Codex,
 * `data.result` on Claude/OpenCode) that used to bypass slimming entirely to
 * keep the expanded-row UI working. Keep the fields the UI actually renders
 * and summarize the result like regular tool output.
 */
function projectMcpToolCallData(
  data: Record<string, unknown>,
  budget: ToolValueBudget,
): Record<string, unknown> {
  const projectedData: Record<string, unknown> = {};

  const item = asRecord(data.item);
  if (item) {
    const projectedItem: Record<string, unknown> = {};
    for (const key of MCP_ITEM_KEPT_FIELDS) {
      if (key in item) {
        projectedItem[key] = projectBoundedToolValue(item[key], budget);
      }
    }
    const result = summarizeMcpResult(item.result);
    if (result) {
      projectedItem.result = result;
    }
    projectedData.item = projectedItem;
  }

  if ("toolName" in data) {
    projectedData.toolName = projectBoundedToolValue(data.toolName, budget);
  }
  if ("input" in data) {
    projectedData.input = projectBoundedToolValue(data.input, budget);
  }
  if (!item) {
    const result = summarizeMcpResult(data.result);
    if (result) {
      projectedData.result = result;
    }
  }

  if ("toolCallId" in data) {
    projectedData.toolCallId = projectBoundedToolValue(data.toolCallId, budget);
  }
  if ("kind" in data) {
    projectedData.kind = projectBoundedToolValue(data.kind, budget);
  }

  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);
  if (changedFiles.length > 0) {
    projectedData.files = changedFiles.map((path) => ({ path }));
  }

  return projectedData;
}

function projectRawOutput(value: unknown): Record<string, unknown> | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    const summary = summarizeToolTextOutput(direct);
    return summary ? { content: summary } : undefined;
  }

  const rawOutput = asRecord(value);
  if (!rawOutput) {
    return undefined;
  }

  if (typeof rawOutput.totalFiles === "number" && Number.isFinite(rawOutput.totalFiles)) {
    return {
      totalFiles: rawOutput.totalFiles,
      ...(rawOutput.truncated === true ? { truncated: true } : {}),
    };
  }

  const content = asTrimmedString(rawOutput.content);
  if (content) {
    const summary = summarizeToolTextOutput(content);
    return summary ? { content: summary } : undefined;
  }

  const stdout = asTrimmedString(rawOutput.stdout);
  if (stdout) {
    const summary = summarizeToolTextOutput(stdout);
    return summary ? { content: summary } : undefined;
  }

  const stderr = asTrimmedString(rawOutput.stderr);
  if (stderr) {
    const summary = summarizeToolTextOutput(stderr);
    return summary ? { content: summary } : undefined;
  }

  return undefined;
}

function projectAcpContent(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const entryValue of value) {
    const entry = asRecord(entryValue);
    const content = asRecord(entry?.content);
    if (entry?.type !== "content" || content?.type !== "text" || typeof content.text !== "string") {
      continue;
    }
    const summary = summarizeToolTextOutput(content.text);
    if (summary !== null) {
      return { content: summary };
    }
  }
  return undefined;
}

/**
 * Removes activity payload fields that no current client reads while retaining
 * the full payload in persistence and the event store.
 */
export function projectActivityPayload(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  const summary = truncateActivityText(activity.summary, ACTIVITY_SUMMARY_CHARACTER_LIMIT);
  if (!payload) {
    return summary === activity.summary ? activity : { ...activity, summary };
  }

  const isToolActivity = activity.kind.startsWith("tool.") || "itemType" in payload;
  const budget = makeToolValueBudget();
  const commonPayload = {
    ...payload,
    ...(typeof payload.detail === "string"
      ? { detail: truncateActivityText(payload.detail, ACTIVITY_DETAIL_CHARACTER_LIMIT) }
      : {}),
    ...(typeof payload.message === "string"
      ? { message: truncateActivityText(payload.message, ACTIVITY_DETAIL_CHARACTER_LIMIT) }
      : {}),
    ...(isToolActivity && payload.command !== undefined
      ? { command: projectBoundedToolValue(payload.command, budget) }
      : {}),
  };
  if (!data) {
    if (!isToolActivity) {
      return { ...activity, summary, payload: commonPayload };
    }
    const bounded = projectBoundedToolValue(commonPayload, budget);
    return {
      ...activity,
      summary,
      payload: asRecord(bounded) ?? {},
    };
  }

  const itemStatus = asRecord(data.item)?.status;
  const projectedPayload =
    payload.status === "completed" && (itemStatus === "failed" || itemStatus === "declined")
      ? { ...commonPayload, status: itemStatus }
      : commonPayload;

  if (payload.itemType === "mcp_tool_call") {
    return {
      ...activity,
      summary,
      payload: {
        ...projectedPayload,
        data: projectMcpToolCallData(data, budget),
      },
    };
  }

  const projectedData: Record<string, unknown> = {};
  const item = projectCommandData(data, budget);
  if (item) {
    projectedData.item = item;
  }
  const command = projectCommandValue(data);
  if (command !== undefined) {
    projectedData.command = projectBoundedToolValue(command, budget);
  }

  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);
  if (changedFiles.length > 0) {
    // Both clients discover file names by walking objects with path-like keys.
    projectedData.files = changedFiles.map((path) => ({ path }));
  }

  if ("toolCallId" in data) {
    projectedData.toolCallId = projectBoundedToolValue(data.toolCallId, budget);
  }
  if ("kind" in data) {
    projectedData.kind = projectBoundedToolValue(data.kind, budget);
  }

  const rawOutput = projectRawOutput(data.rawOutput) ?? projectAcpContent(data.content);
  if (rawOutput) {
    projectedData.rawOutput = rawOutput;
  }

  return {
    ...activity,
    summary,
    payload: {
      ...projectedPayload,
      data: projectedData,
    },
  };
}

/**
 * Matches the validity rule in the web client's
 * `deriveLatestContextWindowSnapshot`: rows without a finite, non-negative
 * `usedTokens` are skipped during its backward walk, so they must not shadow
 * an earlier resolvable row here.
 */
function isResolvableContextWindowActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-window.updated") {
    return false;
  }
  const payload = asRecord(activity.payload);
  const usedTokens = payload?.usedTokens;
  return typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
}

/**
 * Drops all but the last resolvable context-window activity per turn from a
 * snapshot. Clients only ever read the latest usage value (walking the array
 * backwards), so shipping the full history — often thousands of rows on long
 * threads — buys nothing. Retention is per turn rather than per thread because
 * a live `thread.reverted` makes the client discard whole turns; keeping each
 * turn's latest row means the meter can still resolve a value from the turns
 * that survive. Malformed rows pass through untouched rather than shadowing a
 * valid earlier row. Live `thread.activity-appended` events are untouched:
 * newer updates still stream through and supersede the retained rows on the
 * client.
 */
function dropStaleContextWindowActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const latestIndexByTurn = new Map<string | null, number>();
  for (let index = 0; index < activities.length; index += 1) {
    if (isResolvableContextWindowActivity(activities[index]!)) {
      latestIndexByTurn.set(activities[index]!.turnId, index);
    }
  }
  if (latestIndexByTurn.size === 0) {
    return activities;
  }
  return activities.filter(
    (activity, index) =>
      !isResolvableContextWindowActivity(activity) ||
      latestIndexByTurn.get(activity.turnId) === index,
  );
}

/**
 * Identity used to retain only the newest lifecycle row for each call in a
 * thread snapshot. Prefer the runtime item id, then the legacy nested id, and
 * finally the itemType/title/detail triple. Rows without any identity remain
 * untouched.
 */
function toolLifecycleIdentity(activity: OrchestrationThreadActivity): string | null {
  const payload = asRecord(activity.payload);
  if (!payload) {
    return null;
  }

  const toolCallId =
    asTrimmedString(payload.toolCallId) ?? asTrimmedString(asRecord(payload.data)?.toolCallId);
  if (toolCallId) {
    return `id:${toolCallId}`;
  }

  const itemType = asTrimmedString(payload.itemType) ?? "";
  // Mirrors the clients' `normalizeCompactToolLabel`: a completion's title may
  // gain a trailing "complete"/"completed" the in-flight updates lack.
  const label = (asTrimmedString(payload.title) ?? activity.summary)
    .replace(/\s+(?:complete|completed)\s*$/iu, "")
    .trim();
  const detail = asTrimmedString(payload.detail) ?? "";
  if (itemType.length === 0 && label.length === 0 && detail.length === 0) {
    return null;
  }
  return [itemType, label, detail].join("");
}

/**
 * Drops `tool.updated` rows a `tool.completed` row already supersedes. An
 * update is the in-flight snapshot of a call; once the call completes, the
 * completion carries the final state and the clients fold every matching
 * update into it, so shipping the updates buys nothing — 47k such rows exist
 * in one real database, and a single thread carries 2,291 of them totalling
 * ~1MB post-slimming.
 *
 * Matching is per turn for the same reason `dropStaleContextWindowActivities`
 * retains per turn: a live `thread.reverted` makes the client discard whole
 * turns, so a completion in a different turn could vanish and leave the
 * dropped update unrepresented. The completion must also come *after* the
 * update within the turn — a later update belongs to a subsequent call that
 * reuses the same identity and is still in flight. Rows without a lifecycle
 * identity pass through, matching the clients, which never collapse them.
 * Live `thread.activity-appended` events are untouched: updates still stream
 * in real time and the completion supersedes them on the client as before.
 *
 * Deliberate divergence from client collapse: clients fold only *adjacent*
 * lifecycle rows, so a superseded update separated from its completion by an
 * interleaved parallel call renders as its own row today, and this drop
 * removes it. Measured against a real database, that affects 1.5% of dropped
 * rows (553 of 36,581), all pure in-flight state whose final result the
 * retained completion still shows. Dropping them is intentional; matching
 * adjacency server-side would forfeit most of the win for parallel-heavy
 * threads, which are exactly the heavy ones. Superseding completions always
 * carry a payload superset of their updates (verified across all 49,515
 * update rows: zero dropped rows held a client-merged field — detail, title,
 * command, item, kind, files — their completion lacked), so no expanded-row
 * content is lost.
 */
function dropSupersededToolUpdatedActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const completionIndicesByKey = new Map<string, number[]>();
  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index]!;
    if (activity.kind !== "tool.completed") {
      continue;
    }
    const identity = toolLifecycleIdentity(activity);
    if (!identity) {
      continue;
    }
    const key = `${activity.turnId ?? ""} ${identity}`;
    const indices = completionIndicesByKey.get(key);
    if (indices) {
      indices.push(index);
    } else {
      completionIndicesByKey.set(key, [index]);
    }
  }
  if (completionIndicesByKey.size === 0) {
    return activities;
  }

  return activities.filter((activity, index) => {
    if (activity.kind !== "tool.updated") {
      return true;
    }
    const identity = toolLifecycleIdentity(activity);
    if (!identity) {
      return true;
    }
    const indices = completionIndicesByKey.get(`${activity.turnId ?? ""} ${identity}`);
    return !indices?.some((completionIndex) => completionIndex > index);
  });
}

export function projectThreadDetailSnapshot(
  snapshot: OrchestrationThreadDetailSnapshot,
): OrchestrationThreadDetailSnapshot {
  return {
    ...snapshot,
    thread: {
      ...snapshot.thread,
      activities: dropSupersededToolUpdatedActivities(
        dropStaleContextWindowActivities(snapshot.thread.activities),
      ).map(projectActivityPayload),
    },
  };
}

export function projectActivityEvent(event: OrchestrationEvent): OrchestrationEvent {
  if (event.type !== "thread.activity-appended") {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      activity: projectActivityPayload(event.payload.activity),
    },
  };
}
