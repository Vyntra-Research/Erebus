import type {
  PreviewAutomationStatus,
  PreviewSessionSnapshot,
  PreviewTabId,
} from "@t3tools/contracts";

type ReadTabStatus = (tabId: PreviewTabId) => Promise<PreviewAutomationStatus>;

export async function listPreviewAutomationTabs(
  sessions: ReadonlyArray<PreviewSessionSnapshot>,
  activeTabId: PreviewTabId | null,
  readStatus: ReadTabStatus,
) {
  return await Promise.all(
    sessions
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(async (snapshot) => {
        const navStatus = snapshot.navStatus;
        const fallback = {
          url: navStatus._tag === "Idle" ? null : navStatus.url,
          title: navStatus._tag === "Idle" ? null : navStatus.title,
          loading: navStatus._tag === "Loading",
        };
        const status = await readStatus(snapshot.tabId).catch(() => null);
        return {
          tabId: snapshot.tabId,
          active: snapshot.tabId === activeTabId,
          url: status ? status.url : fallback.url,
          title: status ? status.title : fallback.title,
          loading: status ? status.loading : fallback.loading,
          canGoBack: snapshot.canGoBack,
          canGoForward: snapshot.canGoForward,
        };
      }),
  );
}
