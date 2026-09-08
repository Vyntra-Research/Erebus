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

A \`<erebus_user_steer>\` header identifies user text submitted while a run was already active. Its \`freshness="single-use"\` value is a lifetime rule, not a claim that every literal copy is current: apply that delivery once, then expire it at the first automatic compaction. Codex can replay the exact last header and user text literally outside and after the compacted summary. That replay is historical. Do not acknowledge, reapply, restate, or treat it as the latest iteration. Continue from the progress already preserved by the compacted context.

Older recorded headers may still contain \`delivery="live"\`. That value describes only their original transport and is void after the first compaction. It never overrides a compaction boundary or stale-context marker.

Compaction chronology outranks literal display order. When a compacted summary exists, a repeated \`<erebus_user_steer>\` carrying an older id is never the current user turn, the next action, or the most recent actionable instruction merely because Codex placed it after the summary. Do not restart from it. The compacted summary and work after it are newer.

The same rule applies to an \`<erebus_coagent_delivery>\` wrapper around task-to-task coordination. A literal replay after compaction is historical context, not a fresh handback or instruction.

Erebus may send an \`<erebus_context stale_context_id="..." stale_context_kind="...">\` marker after compaction. It marks only that exact last live user steer or co-agent message as historical. The marker records chronology: the marked message came before the compacted summary even if Codex displays its literal replay outside or after that summary. Do not scan or reclassify earlier messages. A genuinely new delivery has a different id and remains authoritative, even when its text repeats an earlier instruction.
`;

export function buildCodexLiveUserSteerPrompt(clientUserMessageId: string, text: string): string {
  return `<erebus_user_steer id="${escapeXmlAttribute(clientUserMessageId)}" freshness="single-use" expires="on-compaction">
<handling>
Apply this user text exactly once on its first delivery during the current uninterrupted run. This static header never proves that a replay is current. At the first automatic compaction this delivery expires. Any later literal copy with this id is historical, even if Codex displays it after the compacted summary. Do not acknowledge or apply that replay again. A later user submission has a different id.
</handling>
</erebus_user_steer>

${text}`;
}

export function buildCodexLiveCoagentMessagePrompt(
  clientUserMessageId: string,
  text: string,
): string {
  return `<erebus_coagent_delivery id="${escapeXmlAttribute(clientUserMessageId)}" freshness="single-use" expires="on-compaction">
<handling>
Apply this task-to-task context exactly once on its first delivery during the current uninterrupted run. This static header never proves that a replay is current. At the first automatic compaction this delivery expires. Any later literal copy with this id is historical, even if Codex displays it after the compacted summary. Do not acknowledge or apply that replay again.
</handling>
</erebus_coagent_delivery>

${text}`;
}

export function buildCodexHistoricalUserSteerMarker(
  clientUserMessageId: string,
  kind: CodexTrackedLiveContextKind = "userSteer",
): string {
  return `<erebus_context stale_context_id="${escapeXmlAttribute(clientUserMessageId)}" stale_context_kind="${kind}">
This is authoritative harness chronology, not a new user request. Automatic context compaction has completed. Only the ${kind === "userSteer" ? "user steer" : "co-agent message"} with this exact id is now historical. It happened before the compacted summary. Any delivery or freshness value inside its original wrapper is now void. If its wrapper and text appear literally outside or after that summary, that display order is a replay artifact, not chronology. It is not the current user turn, the next action, or the latest actionable instruction. Do not restart from, acknowledge, or reapply it. Continue from the progress preserved by the compacted summary and later work. Do not reclassify any other message.
</erebus_context>`;
}

export function buildCodexCompactionBoundaryMarker(compactedTurnId: TurnId): string {
  return `<erebus_context_boundary after_compaction_turn_id="${escapeXmlAttribute(compactedTurnId)}">
This is authoritative harness chronology, not a new user request. Automatic context compaction has completed. Every \`<erebus_user_steer>\` and \`<erebus_coagent_delivery>\` that appears before this boundary is historical, including any literal wrapper that Codex placed outside or after the compacted summary. Its visual position does not make it the current user turn, the next action, or the latest actionable instruction. Do not restart from, acknowledge, restate, or reapply any such replay. Continue from the progress preserved by the compacted summary and later work. Only a genuinely new delivery that appears after this boundary is fresh.
</erebus_context_boundary>`;
}

export function buildCodexPostCompactionContextMarker(
  current: CodexTrackedLiveUserSteer | null,
  compactedTurnId: TurnId,
): string {
  // Codex replays at most the last injected live context as the misleading
  // post-summary user item. Name that exact delivery whenever we know it;
  // the broad boundary is only a recovery fallback when this session did not
  // observe the original delivery.
  return current
    ? buildCodexHistoricalUserSteerMarker(current.clientUserMessageId, current.kind)
    : buildCodexCompactionBoundaryMarker(compactedTurnId);
}

export function buildCodexCompactionContextInstruction(
  current: CodexTrackedLiveUserSteer | null,
): string {
  return current?.state === "historical"
    ? buildCodexHistoricalUserSteerMarker(current.clientUserMessageId, current.kind)
    : "";
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
  _compactedTurnId: TurnId,
): {
  readonly next: CodexTrackedLiveUserSteer | null;
  readonly stale: CodexTrackedLiveUserSteer | null;
} {
  // Codex can report compaction on a later turn than the turn that first
  // delivered the live steer. The compaction belongs to the whole thread
  // context, not only to messages carrying the same turn id. Keep exactly
  // one last live item and retire it on the next root-thread compaction.
  if (current === null || current.state === "historical") {
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

export function contextCompactionSignal(notification: {
  readonly method: string;
  readonly params: unknown;
}): { readonly turnId: TurnId; readonly identity: string } | undefined {
  if (typeof notification.params !== "object" || notification.params === null) return undefined;
  const params = notification.params as {
    readonly turnId?: unknown;
    readonly item?: unknown;
  };
  if (typeof params.turnId !== "string") return undefined;
  if (notification.method === "thread/compacted") {
    return {
      turnId: TurnId.make(params.turnId),
      identity: `legacy-turn:${params.turnId}`,
    };
  }
  if (
    notification.method === "item/completed" &&
    typeof params.item === "object" &&
    params.item !== null &&
    (params.item as { readonly type?: unknown }).type === "contextCompaction"
  ) {
    const itemId = (params.item as { readonly id?: unknown }).id;
    if (typeof itemId !== "string" || itemId.length === 0) return undefined;
    return {
      turnId: TurnId.make(params.turnId),
      identity: `item:${itemId}`,
    };
  }
  return undefined;
}
