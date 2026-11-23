import type {
  PreviewAutomationNavigateInput,
  PreviewAutomationOperation,
  WebRuntimeExtensionAutomationClient,
} from "@t3tools/contracts";

const PREFIX = "extension:";
const BROWSER_PREFIX = "extension-client:";

export interface ExtensionAutomationTarget {
  readonly producerId: string;
  readonly tabId: number;
}

export function extensionNavigateInput(
  input: PreviewAutomationNavigateInput,
  resolvedUrl: string,
): PreviewAutomationNavigateInput {
  const { target: _target, ...inputWithoutTarget } = input;
  return { ...inputWithoutTarget, url: resolvedUrl };
}

export function isExtensionAutomationTargetOperation(
  operation: PreviewAutomationOperation,
): boolean {
  switch (operation) {
    case "status":
    case "open":
    case "navigate":
    case "snapshot":
    case "click":
    case "type":
    case "press":
    case "scroll":
    case "evaluate":
    case "waitFor":
    case "recordingStart":
    case "recordingStop":
    case "resize":
    case "setColorScheme":
    case "tabClose":
    case "back":
    case "forward":
    case "reload":
      return true;
    default:
      return false;
  }
}

export function extensionAutomationBrowserId(producerId: string): string {
  return `${BROWSER_PREFIX}${encodeURIComponent(producerId)}`;
}

export function parseExtensionAutomationBrowserId(value: string | undefined): string | null {
  if (!value?.startsWith(BROWSER_PREFIX)) return null;
  const encoded = value.slice(BROWSER_PREFIX.length);
  if (encoded.length === 0) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function extensionAutomationTabId(producerId: string, tabId: number): string {
  return `${PREFIX}${encodeURIComponent(producerId)}:${tabId}`;
}

export function parseExtensionAutomationTabId(
  value: string | null,
): ExtensionAutomationTarget | null {
  if (!value?.startsWith(PREFIX)) return null;
  const separator = value.lastIndexOf(":");
  if (separator <= PREFIX.length) return null;
  const tabId = Number(value.slice(separator + 1));
  if (!Number.isInteger(tabId)) return null;
  try {
    return {
      producerId: decodeURIComponent(value.slice(PREFIX.length, separator)),
      tabId,
    };
  } catch {
    return null;
  }
}

export function extensionAutomationTabs(
  clients: ReadonlyArray<WebRuntimeExtensionAutomationClient>,
) {
  return clients
    .filter((client) => client.connected)
    .flatMap((client) =>
      client.tabs.map((tab) => ({
        tabId: extensionAutomationTabId(client.producerId, tab.tabId),
        active: tab.active,
        url: tab.url ?? null,
        title: tab.title ?? null,
        loading: tab.status === "loading",
        canGoBack: false,
        canGoForward: false,
      })),
    );
}

export function extensionAutomationBrowsers(
  clients: ReadonlyArray<WebRuntimeExtensionAutomationClient>,
) {
  return clients
    .filter((client) => client.connected)
    .map((client) => ({
      browserId: extensionAutomationBrowserId(client.producerId),
      kind: "extension" as const,
      browser: client.browser,
      version: client.version,
      connected: true,
      tabCount: client.tabs.length,
    }));
}

export function rewriteExtensionAutomationResult(producerId: string, value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteExtensionAutomationResult(producerId, item));
  }
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if ((key === "tabId" || key === "closedTabId") && typeof item === "number") {
      result[key] = extensionAutomationTabId(producerId, item);
    } else {
      result[key] = rewriteExtensionAutomationResult(producerId, item);
    }
  }
  return result;
}
