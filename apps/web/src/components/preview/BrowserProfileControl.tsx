import {
  type DesktopPreviewBrowserProfile,
  type DesktopPreviewBrowserProfileId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Check, Layers3, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  resolveBrowserProfileId,
  useBrowserProfileSelectionStore,
} from "~/browser/browserProfileSelectionStore";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";

import { previewBridge } from "./previewBridge";

interface BrowserProfileControlProps {
  threadRef: ScopedThreadRef;
  tabId: string | null;
}

function profileError(error: unknown): string {
  return error instanceof Error ? error.message : "The browser session could not be updated.";
}

export function BrowserProfileControl({ threadRef, tabId }: BrowserProfileControlProps) {
  const [profiles, setProfiles] = useState<readonly DesktopPreviewBrowserProfile[]>([]);
  const [managerOpen, setManagerOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null);
  const profileId = useBrowserProfileSelectionStore((state) =>
    resolveBrowserProfileId(threadRef, tabId, state),
  );
  const selectForTab = useBrowserProfileSelectionStore((state) => state.selectForTab);
  const setEnvironmentDefault = useBrowserProfileSelectionStore(
    (state) => state.setEnvironmentDefault,
  );
  const removeProfileSelection = useBrowserProfileSelectionStore((state) => state.removeProfile);

  const refresh = useCallback(async () => {
    if (!previewBridge) return;
    try {
      const next = await previewBridge.browserProfiles.list();
      setProfiles(next);
      setDraftNames(Object.fromEntries(next.map((profile) => [profile.id, profile.name])));
      if (!next.some((profile) => profile.id === profileId)) {
        removeProfileSelection(profileId);
      }
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not load browser sessions",
          description: profileError(error),
        }),
      );
    }
  }, [profileId, removeProfileSelection]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const currentProfile = useMemo(
    () => profiles.find((profile) => profile.id === profileId) ?? profiles[0] ?? null,
    [profileId, profiles],
  );

  const selectProfile = (nextProfileId: DesktopPreviewBrowserProfileId) => {
    if (tabId) selectForTab(threadRef, tabId, nextProfileId);
    else setEnvironmentDefault(threadRef.environmentId, nextProfileId);
  };

  const createProfile = async () => {
    const name = newName.trim();
    if (!name || !previewBridge) return;
    setBusyProfileId("new");
    try {
      const created = await previewBridge.browserProfiles.create(name);
      setNewName("");
      await refresh();
      selectProfile(created.id);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not create browser session",
        description: profileError(error),
      });
    } finally {
      setBusyProfileId(null);
    }
  };

  const renameProfile = async (profile: DesktopPreviewBrowserProfile) => {
    const name = draftNames[profile.id]?.trim() ?? "";
    if (!name || name === profile.name || !previewBridge) return;
    setBusyProfileId(profile.id);
    try {
      await previewBridge.browserProfiles.rename(profile.id, name);
      await refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not rename browser session",
        description: profileError(error),
      });
    } finally {
      setBusyProfileId(null);
    }
  };

  const deleteProfile = async (profile: DesktopPreviewBrowserProfile) => {
    if (profile.isDefault || !previewBridge) return;
    setBusyProfileId(profile.id);
    try {
      const result = await previewBridge.browserProfiles.delete(profile.id);
      if (result?.status === "in-use") {
        throw new Error(
          `Close the ${result.activeTabCount} open browser tab${result.activeTabCount === 1 ? "" : "s"} using this profile before deleting it.`,
        );
      }
      removeProfileSelection(profile.id);
      await refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not delete browser session",
        description: profileError(error),
      });
    } finally {
      setBusyProfileId(null);
    }
  };

  if (!previewBridge) return null;

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="max-w-32 gap-1.5 px-2 text-muted-foreground"
              aria-label={`Browser session: ${currentProfile?.name ?? "Default"}`}
            />
          }
        >
          <Layers3 className="size-3.5" />
          <span className="truncate text-[11px]">{currentProfile?.name ?? "Default"}</span>
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-52">
          {profiles.map((profile) => (
            <MenuItem key={profile.id} onClick={() => selectProfile(profile.id)}>
              <span className="min-w-0 flex-1 truncate">{profile.name}</span>
              {profile.id === profileId ? <Check className="size-3.5" /> : null}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onClick={() => setManagerOpen(true)}>
            <Pencil />
            Manage sessions
          </MenuItem>
        </MenuPopup>
      </Menu>

      <Dialog open={managerOpen} onOpenChange={setManagerOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Browser sessions</DialogTitle>
            <DialogDescription>
              Each session keeps its own accounts, cookies, storage, cache, and capture route.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 px-6 py-5">
            <div className="flex gap-2">
              <Input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void createProfile();
                }}
                placeholder="Session name, e.g. Admin"
                aria-label="New browser session name"
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0 gap-1.5"
                disabled={!newName.trim() || busyProfileId !== null}
                onClick={() => void createProfile()}
              >
                <Plus className="size-3.5" />
                Add
              </Button>
            </div>

            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {profiles.map((profile) => {
                const draftName = draftNames[profile.id] ?? profile.name;
                const changed = draftName.trim().length > 0 && draftName.trim() !== profile.name;
                return (
                  <div
                    key={profile.id}
                    className={cn(
                      "flex items-center gap-2 rounded-lg bg-muted/35 p-2",
                      profile.id === profileId && "bg-primary/8",
                    )}
                  >
                    <Input
                      value={draftName}
                      disabled={profile.isDefault || busyProfileId !== null}
                      onChange={(event) =>
                        setDraftNames((current) => ({
                          ...current,
                          [profile.id]: event.target.value,
                        }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void renameProfile(profile);
                      }}
                      aria-label={`Name for ${profile.name}`}
                    />
                    {!profile.isDefault ? (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={!changed || busyProfileId !== null}
                          onClick={() => void renameProfile(profile)}
                          aria-label={`Save ${profile.name}`}
                        >
                          <Check className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={busyProfileId !== null}
                          onClick={() => void deleteProfile(profile)}
                          aria-label={`Delete ${profile.name}`}
                        >
                          <Trash2 className="size-3.5 text-destructive" />
                        </Button>
                      </>
                    ) : (
                      <span className="px-2 text-[11px] text-muted-foreground">Default</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Done</DialogClose>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
