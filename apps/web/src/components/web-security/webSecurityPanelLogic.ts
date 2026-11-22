import {
  webRuntimeBrowserCaptureSource,
  webRuntimeBrowserProfileId,
  type DesktopPreviewBrowserProfileId,
  type WebRuntimeCaptureSession,
} from "@t3tools/contracts";

export interface RuntimeRestartCleanup {
  readonly restarted: boolean;
  readonly profileIds: readonly DesktopPreviewBrowserProfileId[];
}

export function runtimeRestartCleanup(
  previousRestartCount: number | null,
  nextRestartCount: number,
  sessions: readonly WebRuntimeCaptureSession[],
): RuntimeRestartCleanup {
  const restarted = previousRestartCount !== null && previousRestartCount !== nextRestartCount;
  if (!restarted) return { restarted: false, profileIds: [] };

  const profileIds = new Set<DesktopPreviewBrowserProfileId>();
  for (const session of sessions) {
    if (session.endedAt !== null) continue;
    const profileId = webRuntimeBrowserProfileId(session.source);
    if (profileId !== null) profileIds.add(profileId as DesktopPreviewBrowserProfileId);
  }
  return { restarted: true, profileIds: [...profileIds] };
}

export function mergeEvidenceById<T extends { readonly id: string }>(
  first: readonly T[],
  second: readonly T[],
): readonly T[] {
  const ids = new Set(first.map((item) => item.id));
  return [...first, ...second.filter((item) => !ids.has(item.id))];
}

export function parseReplayHeaders(
  value: string,
):
  | { readonly headers: readonly { readonly name: string; readonly value: string }[] }
  | { readonly error: string } {
  const headers: { name: string; value: string }[] = [];
  for (const [index, rawLine] of value.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    const name = separator < 0 ? "" : line.slice(0, separator).trim();
    if (!name) return { error: `Header line ${index + 1} needs a name followed by a colon.` };
    headers.push({ name, value: line.slice(separator + 1).trim() });
  }
  return { headers };
}

export function parseAnnotationTags(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

export function browserCaptureSource(profileId: DesktopPreviewBrowserProfileId): string {
  return webRuntimeBrowserCaptureSource(profileId);
}

export function captureSourceConfiguration(
  profileId: DesktopPreviewBrowserProfileId | null,
  extensionBrowser: "chromium" | "firefox" = "chromium",
): {
  readonly source: string;
  readonly proxy: boolean;
} {
  return profileId === null
    ? extensionBrowser === "firefox"
      ? { source: "extension:firefox", proxy: true }
      : { source: "extension:chromium", proxy: false }
    : { source: browserCaptureSource(profileId), proxy: true };
}

export function findActiveProfileCapture(
  sessions: readonly WebRuntimeCaptureSession[],
  profileId: DesktopPreviewBrowserProfileId,
): WebRuntimeCaptureSession | undefined {
  const source = browserCaptureSource(profileId);
  return sessions.find((session) => session.endedAt === null && session.source === source);
}

export type BrowserProfileCaptureState =
  | { readonly kind: "idle" }
  | { readonly kind: "capturing"; readonly session: WebRuntimeCaptureSession }
  | { readonly kind: "resume"; readonly session: WebRuntimeCaptureSession };

export function resolveBrowserProfileCaptureState(
  sessions: readonly WebRuntimeCaptureSession[],
  profileId: DesktopPreviewBrowserProfileId,
): BrowserProfileCaptureState {
  const session = findActiveProfileCapture(sessions, profileId);
  if (!session) return { kind: "idle" };
  return session.proxy ? { kind: "capturing", session } : { kind: "resume", session };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function captureRollbackFailure(proxyError: unknown, rollbackError: unknown): Error {
  return new Error(
    `Browser proxy setup failed: ${errorMessage(proxyError)} Capture rollback also failed: ${errorMessage(rollbackError)}`,
  );
}

export async function endCaptureAfterProxyClear(input: {
  readonly clearProxy: () => Promise<void>;
  readonly endCapture: () => Promise<void>;
  readonly restoreProxy?: () => Promise<void>;
}): Promise<void> {
  await input.clearProxy();
  try {
    await input.endCapture();
  } catch (endError) {
    if (!input.restoreProxy) throw endError;
    try {
      await input.restoreProxy();
    } catch (restoreError) {
      throw new Error(
        `Capture stop failed: ${errorMessage(endError)} Browser proxy restore also failed: ${errorMessage(restoreError)}`,
        { cause: restoreError },
      );
    }
    throw endError;
  }
}

export function hasAnotherActiveCaptureForSource(
  sessions: readonly WebRuntimeCaptureSession[],
  session: WebRuntimeCaptureSession,
): boolean {
  return sessions.some(
    (candidate) =>
      candidate.id !== session.id &&
      candidate.endedAt === null &&
      candidate.source === session.source,
  );
}
