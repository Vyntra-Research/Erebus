import type {
  EnvironmentId,
  ProviderInstanceId,
  ResearchProteusHealth,
  ThreadId,
} from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly previewEnabled: boolean;
  readonly researchFallbackEndpoint?: string;
  readonly authorizationHeader: string;
  readonly proteusHealth?: ResearchProteusHealth;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function setMcpProviderSessionProteusHealth(
  threadId: ThreadId,
  proteusHealth: ResearchProteusHealth,
): void {
  const current = sessionsByThread.get(threadId);
  if (!current) return;
  sessionsByThread.set(threadId, { ...current, proteusHealth });
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
