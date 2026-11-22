import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
  type DesktopPreviewBrowserProfileId,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

interface BrowserProfileSelection {
  profileId: DesktopPreviewBrowserProfileId;
  updatedAt: number;
}

interface BrowserProfileSelectionState {
  byEnvironment: Record<string, DesktopPreviewBrowserProfileId>;
  byTab: Record<string, BrowserProfileSelection>;
  selectForTab: (
    ref: ScopedThreadRef,
    tabId: string,
    profileId: DesktopPreviewBrowserProfileId,
  ) => void;
  setEnvironmentDefault: (
    environmentId: EnvironmentId,
    profileId: DesktopPreviewBrowserProfileId,
  ) => void;
  removeProfile: (profileId: DesktopPreviewBrowserProfileId) => void;
}

const STORAGE_KEY = "erebus:browser-profile-selection:v1";
const MAX_PERSISTED_TAB_SELECTIONS = 256;

export function browserProfileTabKey(ref: ScopedThreadRef, tabId: string): string {
  return `${scopedThreadKey(ref)}:${tabId}`;
}

export const useBrowserProfileSelectionStore = create<BrowserProfileSelectionState>()(
  persist(
    (set) => ({
      byEnvironment: {},
      byTab: {},
      selectForTab: (ref, tabId, profileId) =>
        set((state) => {
          const entries = Object.entries({
            ...state.byTab,
            [browserProfileTabKey(ref, tabId)]: { profileId, updatedAt: Date.now() },
          })
            .toSorted(([, left], [, right]) => right.updatedAt - left.updatedAt)
            .slice(0, MAX_PERSISTED_TAB_SELECTIONS);
          return {
            byTab: Object.fromEntries(entries),
          };
        }),
      setEnvironmentDefault: (environmentId, profileId) =>
        set((state) => ({
          byEnvironment: { ...state.byEnvironment, [environmentId]: profileId },
        })),
      removeProfile: (profileId) =>
        set((state) => ({
          byEnvironment: Object.fromEntries(
            Object.entries(state.byEnvironment).map(([environmentId, selected]) => [
              environmentId,
              selected === profileId ? DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID : selected,
            ]),
          ),
          byTab: Object.fromEntries(
            Object.entries(state.byTab).map(([tabKey, selection]) => [
              tabKey,
              selection.profileId === profileId
                ? {
                    profileId: DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID,
                    updatedAt: Date.now(),
                  }
                : selection,
            ]),
          ),
        })),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: ({ byEnvironment, byTab }) => ({ byEnvironment, byTab }),
    },
  ),
);

export function resolveBrowserProfileId(
  ref: ScopedThreadRef,
  tabId: string | null,
  state: Pick<BrowserProfileSelectionState, "byEnvironment" | "byTab">,
): DesktopPreviewBrowserProfileId {
  if (tabId) {
    const selected = state.byTab[browserProfileTabKey(ref, tabId)]?.profileId;
    if (selected) return selected;
  }
  return state.byEnvironment[ref.environmentId] ?? DEFAULT_DESKTOP_PREVIEW_BROWSER_PROFILE_ID;
}
