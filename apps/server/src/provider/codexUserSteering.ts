import { TurnId } from "@t3tools/contracts";

export const EREBUS_CONTEXT_CLIENT_ID_PREFIX = "erebus-context:";
export const EREBUS_USER_STEER_CLIENT_ID_PREFIX = "erebus-user-steer:";

export interface CodexTrackedLiveUserSteer {
  readonly clientUserMessageId: string;
  readonly turnId: TurnId;
  readonly state: "fresh" | "historical";
}

const escapeXmlAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export const EREBUS_USER_STEER_DEVELOPER_INSTRUCTIONS = `

## Erebus live user steering

A \`<erebus_user_steer>\` header identifies user text submitted while a run was already active. Apply that text once on its first delivery. Codex can replay the exact last header and user text literally after automatic context compaction, outside and after the compacted summary. That replay is historical even when the header still says \`delivery="live"\`: do not acknowledge, reapply, restate, or treat it as the latest iteration. Continue from the progress already preserved by the compacted context.

Erebus may send an \`<erebus_context stale_user_steer_id="...">\` marker after compaction. It marks only that exact steer as historical. Do not scan or reclassify earlier user messages. A genuinely new user steer has a different id and remains authoritative, even when its text repeats an earlier instruction.
`;

export function buildCodexLiveUserSteerPrompt(clientUserMessageId: string, text: string): string {
  return `<erebus_user_steer id="${escapeXmlAttribute(clientUserMessageId)}" delivery="live">
<handling>
This header and the user text below are fresh only on their first delivery during the current uninterrupted run. If Codex replays them literally after automatic context compaction, they are historical. Do not acknowledge or apply that replay again. A later user submission has a different id.
</handling>
</erebus_user_steer>

${text}`;
}

export function buildCodexHistoricalUserSteerMarker(clientUserMessageId: string): string {
  return `<erebus_context stale_user_steer_id="${escapeXmlAttribute(clientUserMessageId)}">
This is harness control metadata, not a new user request. Automatic context compaction has completed. Only the user steer with this exact id is now historical. If its header and text appear again outside or after the compacted summary, do not acknowledge or reapply them. Continue from the current compacted progress. Do not reclassify any other user message.
</erebus_context>`;
}

export function erebusContextClientId(clientUserMessageId: string): string {
  return `${EREBUS_CONTEXT_CLIENT_ID_PREFIX}${clientUserMessageId}`;
}

export function erebusUserSteerClientId(clientUserMessageId: string): string {
  return `${EREBUS_USER_STEER_CLIENT_ID_PREFIX}${clientUserMessageId}`;
}

export function deliveredLiveUserSteerId(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const candidate = item as { readonly type?: unknown; readonly clientId?: unknown };
  if (
    candidate.type !== "userMessage" ||
    typeof candidate.clientId !== "string" ||
    !candidate.clientId.startsWith(EREBUS_USER_STEER_CLIENT_ID_PREFIX)
  ) {
    return undefined;
  }
  const id = candidate.clientId.slice(EREBUS_USER_STEER_CLIENT_ID_PREFIX.length);
  return id.length > 0 ? id : undefined;
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
