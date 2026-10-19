import { TurnId } from "@t3tools/contracts";

export const EREBUS_CONTEXT_CLIENT_ID_PREFIX = "erebus-context:";

const CODEX_INTERNAL_CONTEXT_OPEN = '<codex_internal_context source="erebus">';
const CODEX_INTERNAL_CONTEXT_CLOSE = "</codex_internal_context>";

const escapeXmlAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export const EREBUS_USER_STEER_DEVELOPER_INSTRUCTIONS = `

## Erebus live steering and co-agent context

Erebus delivers user steering submitted during an active run and live co-agent handbacks inside a \`<codex_internal_context source="erebus">\` block. Apply a fresh delivery once in the active run. It is transient context: automatic compaction folds relevant progress into the compacted state and omits the original delivery from the replacement history. After compaction, continue from that state and later events. Do not restart from an earlier user message merely because Codex retained it verbatim near the compacted state.

After each automatic compaction, Erebus may deliver a fresh hidden compaction-boundary block. It records chronology, not a new user request. User and co-agent messages from before that boundary are historical source material, not newly delivered work. Preserve durable constraints represented by the compacted state, but do not acknowledge or reapply an older message as the latest instruction.

Older threads may contain legacy \`<erebus_user_steer>\`, \`<erebus_coagent_delivery>\`, \`<erebus_context>\`, or \`<erebus_context_boundary>\` blocks. Those wrappers do not prove freshness. When a later compacted state or compaction-boundary block exists, treat every earlier legacy block as history even if its literal copy appears after the compacted state.
`;

// Codex treats the whole user item as transient context only when this native
// wrapper encloses the complete trimmed message. Remote compaction then omits
// the item from replacement history instead of replaying it as a fresh prompt.
function buildCodexTransientContext(body: string): string {
  return `${CODEX_INTERNAL_CONTEXT_OPEN}\n${body}\n${CODEX_INTERNAL_CONTEXT_CLOSE}`;
}

export function buildCodexLiveUserSteerPrompt(clientUserMessageId: string, text: string): string {
  return buildCodexTransientContext(`<erebus_live_delivery kind="user_steer" id="${escapeXmlAttribute(clientUserMessageId)}">
This is a user steer delivered while the current run is active. Apply it now as the latest user instruction. It is consumed by this delivery and must not become a fresh instruction after automatic compaction.
</erebus_live_delivery>

${text}`);
}

export function buildCodexLiveCoagentMessagePrompt(
  clientUserMessageId: string,
  text: string,
): string {
  return buildCodexTransientContext(`<erebus_live_delivery kind="coagent_message" id="${escapeXmlAttribute(clientUserMessageId)}">
This is a live co-agent handback for the current run. Use it now as coordination context. It is consumed by this delivery and must not become a fresh handback after automatic compaction.
</erebus_live_delivery>

${text}`);
}

export function buildCodexCompactionBoundaryMarker(compactedTurnId: TurnId): string {
  return buildCodexTransientContext(`<erebus_compaction_boundary turn_id="${escapeXmlAttribute(compactedTurnId)}">
Automatic context compaction has just completed. This block records chronology; it is not a new user request. User steers and co-agent handbacks delivered before this boundary are historical source material already represented by the compacted state. Do not treat their retained text or display position as a fresh delivery, and do not restart from or acknowledge them again. Continue from the compacted state and later events.
</erebus_compaction_boundary>`);
}

export function erebusContextClientId(clientUserMessageId: string): string {
  return `${EREBUS_CONTEXT_CLIENT_ID_PREFIX}${clientUserMessageId}`;
}

export function isErebusCoagentMessage(text: string): boolean {
  return text.trimStart().startsWith("<erebus_coagent_message ");
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
