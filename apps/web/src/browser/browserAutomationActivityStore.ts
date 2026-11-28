import { create } from "zustand";

interface BrowserAutomationActivityStoreState {
  readonly referencesByTabId: Readonly<Record<string, number>>;
  readonly acquire: (tabId: string) => void;
  readonly release: (tabId: string) => void;
}

export const useBrowserAutomationActivityStore = create<BrowserAutomationActivityStoreState>()(
  (set) => ({
    referencesByTabId: {},
    acquire: (tabId) =>
      set((state) => ({
        referencesByTabId: {
          ...state.referencesByTabId,
          [tabId]: (state.referencesByTabId[tabId] ?? 0) + 1,
        },
      })),
    release: (tabId) =>
      set((state) => {
        const references = state.referencesByTabId[tabId] ?? 0;
        if (references <= 1) {
          const { [tabId]: _released, ...referencesByTabId } = state.referencesByTabId;
          return { referencesByTabId };
        }
        return {
          referencesByTabId: {
            ...state.referencesByTabId,
            [tabId]: references - 1,
          },
        };
      }),
  }),
);

export function acquireBrowserAutomationActivity(tabId: string): () => void {
  useBrowserAutomationActivityStore.getState().acquire(tabId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    useBrowserAutomationActivityStore.getState().release(tabId);
  };
}
