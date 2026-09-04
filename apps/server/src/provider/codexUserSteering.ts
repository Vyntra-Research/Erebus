import { TurnId } from "@t3tools/contracts";

export const EREBUS_CONTEXT_CLIENT_ID_PREFIX = "erebus-context:";
export const EREBUS_USER_STEER_CLIENT_ID_PREFIX = "erebus-user-steer:";
export const EREBUS_COAGENT_STEER_CLIENT_ID_PREFIX = "erebus-coagent-steer:";

export type CodexTrackedLiveContextKind = "userSteer" | "coagentMessage";

export interface CodexTrackedLiveUserSteer {
  readonly clientUserMessageId: string;
  readonly turnId: TurnId;
  readonly kind: CodexTrackedLiveContextKind;
  readonly state: "fresh" | "historical";
}

const escapeXmlAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export const EREBUS_USER_STEER_DEVELOPER_INSTRUCTIONS = `

## Erebus live steering and co-agent context

A \`<erebus_user_steer>\` header identifies user text submitted while a run was already active. Apply that text once on its first delivery. Codex can replay the exact last header and user text literally after automatic context compaction, outside and after the compacted summary. That replay is historical even when the header still says \`delivery="live"\`: do not acknowledge, reapply, restate, or treat it as the latest iteration. Continue from the progress already preserved by the compacted context.

The same rule applies to an \`<erebus_coagent_delivery>\` wrapper around task-to-task coordination. A literal replay after compaction is historical context, not a fresh handback or instruction.

Erebus may send an \`<erebus_context stale_context_id="..." stale_context_kind="...">\` marker after compaction. It marks only that exact last live user steer or co-agent message as historical. The marker records chronology: the marked message came before the compacted summary even if Codex displays its literal replay outside or after that summary. Do not scan or reclassify earlier messages. A genuinely new delivery has a different id and remains authoritative, even when its text repeats an earlier instruction.
`;

export function buildCodexLiveUserSteerPrompt(clientUserMessageId: string, text: string): string {
  return `<erebus_user_steer id="${escapeXmlAttribute(clientUserMessageId)}" delivery="live">
<handling>
This header and the user text below are fresh only on their first delivery during the current uninterrupted run. If Codex replays them literally after automatic context compaction, they are historical. Do not acknowledge or apply that replay again. A later user submission has a different id.
</handling>
</erebus_user_steer>

${text}`;
}

export function buildCodexLiveCoagentMessagePrompt(
  clientUserMessageId: string,
  text: string,
): string {
  return `<erebus_coagent_delivery id="${escapeXmlAttribute(clientUserMessageId)}" delivery="live">
<handling>
This task-to-task context is fresh only on its first delivery during the current uninterrupted run. If Codex replays it literally after automatic context compaction, it is historical. Its visual position after the compacted summary does not make it newer. Do not acknowledge or apply that replay again.
</handling>
</erebus_coagent_delivery>

${text}`;
}

export function buildCodexHistoricalUserSteerMarker(
  clientUserMessageId: string,
  kind: CodexTrackedLiveContextKind = "userSteer",
): string {
  return `<erebus_context stale_context_id="${escapeXmlAttribute(clientUserMessageId)}" stale_context_kind="${kind}">
This is harness control metadata, not a new user request. Automatic context compaction has completed. Only the ${kind === "userSteer" ? "user steer" : "co-agent message"} with this exact id is now historical. It happened before the compacted summary. If its wrapper and text appear literally outside or after that summary, that display order is a replay artifact, not chronology. Do not acknowledge or reapply it. Continue from the progress preserved by the compacted summary and later work. Do not reclassify any other message.
</erebus_context>`;
}

export function erebusContextClientId(clientUserMessageId: string): string {
  return `${EREBUS_CONTEXT_CLIENT_ID_PREFIX}${clientUserMessageId}`;
}

export function erebusUserSteerClientId(clientUserMessageId: string): string {
  return `${EREBUS_USER_STEER_CLIENT_ID_PREFIX}${clientUserMessageId}`;
}

export function erebusCoagentSteerClientId(clientUserMessageId: string): string {
  return `${EREBUS_COAGENT_STEER_CLIENT_ID_PREFIX}${clientUserMessageId}`;
}

export function isErebusCoagentMessage(text: string): boolean {
  return text.trimStart().startsWith("<erebus_coagent_message ");
}

export function deliveredLiveContext(
  item: unknown,
):
  | { readonly clientUserMessageId: string; readonly kind: CodexTrackedLiveContextKind }
  | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const candidate = item as { readonly type?: unknown; readonly clientId?: unknown };
  if (candidate.type !== "userMessage" || typeof candidate.clientId !== "string") {
    return undefined;
  }
  const prefixes = [
    [EREBUS_USER_STEER_CLIENT_ID_PREFIX, "userSteer"],
    [EREBUS_COAGENT_STEER_CLIENT_ID_PREFIX, "coagentMessage"],
  ] as const;
  for (const [prefix, kind] of prefixes) {
    if (!candidate.clientId.startsWith(prefix)) continue;
    const clientUserMessageId = candidate.clientId.slice(prefix.length);
    return clientUserMessageId.length > 0 ? { clientUserMessageId, kind } : undefined;
  }
  return undefined;
}

export function deliveredLiveUserSteerId(item: unknown): string | undefined {
  const context = deliveredLiveContext(item);
  return context?.kind === "userSteer" ? context.clientUserMessageId : undefined;
}

export function markTrackedUserSteerHistorical(
  current: CodexTrackedLiveUserSteer | null,
  compactedTurnId: TurnId,
): {
  readonly next: CodexTrackedLiveUserSteer | null;
  readonly stale: CodexTrackedLiveUserSteer | null;
} {
  if (current === null || current.state === "historical" || current.turnId !== compactedTurnId) {
    return { next: current, stale: null };
  }
  const historical = { ...current, state: "historical" as const };
  return { next: historical, stale: historical };
}

export function isHiddenErebusContextItem(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const candidate = item as { readonly type?: unknown; readonly clientId?: unknown };
  return (
    candidate.type === "userMessage" &&
    typeof candidate.clientId === "string" &&
    candidate.clientId.startsWith(EREBUS_CONTEXT_CLIENT_ID_PREFIX)
  );
}

export function contextCompactionTurnId(notification: {
  readonly method: string;
  readonly params: unknown;
}): TurnId | undefined {
  if (typeof notification.params !== "object" || notification.params === null) return undefined;
  const params = notification.params as {
    readonly turnId?: unknown;
    readonly item?: unknown;
  };
  if (typeof params.turnId !== "string") return undefined;
  if (notification.method === "thread/compacted") return TurnId.make(params.turnId);
  if (
    notification.method === "item/completed" &&
    typeof params.item === "object" &&
    params.item !== null &&
    (params.item as { readonly type?: unknown }).type === "contextCompaction"
  ) {
    return TurnId.make(params.turnId);
  }
  return undefined;
}
