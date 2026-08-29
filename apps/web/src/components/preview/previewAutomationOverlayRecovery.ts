import type { PreviewAutomationStatus } from "@t3tools/contracts";

export interface PreviewAutomationOverlayBridge {
  readonly registerWebview: (tabId: string, webContentsId: number) => Promise<void>;
  readonly automation: {
    readonly status: (tabId: string) => Promise<PreviewAutomationStatus>;
  };
}

export interface PreviewAutomationWebviewRegistration {
  readonly getWebContentsId: () => number;
}

export interface PreviewAutomationOverlayRecoveryResult {
  readonly available: boolean;
  readonly registeredWebContentsId: number | null;
}

export async function recoverPreviewAutomationOverlay(input: {
  readonly bridge: PreviewAutomationOverlayBridge;
  readonly runtimeTabId: string;
  readonly webview: PreviewAutomationWebviewRegistration | null;
  readonly registeredWebContentsId: number | null;
}): Promise<PreviewAutomationOverlayRecoveryResult> {
  const initialStatus = await input.bridge.automation.status(input.runtimeTabId);
  if (initialStatus.available) {
    return { available: true, registeredWebContentsId: input.registeredWebContentsId };
  }

  const webContentsId = input.webview?.getWebContentsId();
  if (!webContentsId || webContentsId <= 0) {
    return { available: false, registeredWebContentsId: input.registeredWebContentsId };
  }
  if (webContentsId !== input.registeredWebContentsId) {
    await input.bridge.registerWebview(input.runtimeTabId, webContentsId);
  }
  const status = await input.bridge.automation.status(input.runtimeTabId);
  return { available: status.available, registeredWebContentsId: webContentsId };
}
