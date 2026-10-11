import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  ThreadId,
  ThreadSyncConflict,
  ThreadSyncPullResolution,
  ThreadSyncPushInput,
  ThreadSyncPushResolution,
  ThreadSyncStatus,
  ThreadSyncUnlinkedProject,
} from "@t3tools/contracts";
import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  CircleCheckIcon,
  GitCompareArrowsIcon,
  Link2Icon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  UnplugIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentProjects } from "../../state/projects";
import { primaryThreadSyncStatusAtom, threadSyncEnvironment } from "../../state/threadSync";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type ThreadSyncDialog = "pull" | "push" | "projects" | null;

export type ThreadSyncPresentation = {
  readonly label: string;
  readonly tone: "idle" | "busy" | "success" | "warning" | "error";
};

export function getThreadSyncPresentation(
  status: ThreadSyncStatus | null,
  environmentAvailable = true,
): ThreadSyncPresentation {
  if (!environmentAvailable) {
    return { label: "Thread sync is unavailable", tone: "idle" };
  }
  if (status === null) {
    return { label: "Loading thread sync", tone: "busy" };
  }
  if (status.state === "disconnected") {
    return { label: "Set up thread sync", tone: "idle" };
  }
  if (status.state === "error" || status.lastError !== null) {
    return { label: "Thread sync needs attention", tone: "error" };
  }
  if (status.state === "fetching") {
    return { label: "Checking thread sync", tone: "busy" };
  }
  if (status.state === "pulling") {
    return { label: "Pulling thread history", tone: "busy" };
  }
  if (status.state === "pushing") {
    return { label: "Pushing thread history", tone: "busy" };
  }
  if (
    status.conflicts.length > 0 ||
    status.unlinkedProjects.length > 0 ||
    status.pendingPullCount > 0 ||
    status.pendingPushCount > 0
  ) {
    return { label: "Thread sync has pending changes", tone: "warning" };
  }
  return { label: "Thread sync is up to date", tone: "success" };
}

export function buildConflictStrategies(
  conflicts: ReadonlyArray<ThreadSyncConflict>,
  resolutions: Readonly<Record<string, ThreadSyncPullResolution | ThreadSyncPushResolution>>,
  fallback: ThreadSyncPullResolution | ThreadSyncPushResolution,
): ReadonlyArray<{
  readonly threadId: ThreadId;
  readonly resolution: ThreadSyncPullResolution | ThreadSyncPushResolution;
}> {
  return conflicts.map((conflict) => ({
    threadId: conflict.threadId,
    resolution: resolutions[conflict.threadId] ?? fallback,
  }));
}

export function canPushThreadSync(status: ThreadSyncStatus, busy: boolean): boolean {
  return (
    !busy &&
    status.configuration !== null &&
    (status.pendingPushCount > 0 || status.conflicts.length > 0) &&
    status.unlinkedProjects.length === 0
  );
}

export function canPullThreadSync(status: ThreadSyncStatus, busy: boolean): boolean {
  return (
    !busy &&
    status.configuration !== null &&
    status.remoteRevision !== null &&
    (status.pendingPullCount > 0 || status.conflicts.length > 0) &&
    status.unlinkedProjects.length === 0
  );
}

export function buildThreadSyncPushInput(
  remoteRevision: ThreadSyncStatus["remoteRevision"],
  strategies: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly resolution: ThreadSyncPullResolution | ThreadSyncPushResolution;
  }>,
): ThreadSyncPushInput {
  return {
    expectedRemoteRevision: remoteRevision,
    strategies: strategies.map(({ threadId, resolution }) => ({
      threadId,
      resolution: resolution as ThreadSyncPushResolution,
    })),
  };
}

export function updateThreadSyncSelection<Value extends string>(
  current: Readonly<Record<string, Value>>,
  key: string,
  value: Value,
): Record<string, Value> {
  return { ...current, [key]: value };
}

function formatLastFetched(value: string | null): string {
  if (value === null) return "Not checked yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Last check unavailable";
  return `Checked ${date.toLocaleString()}`;
}

function ThreadSyncStatusIcon({ presentation }: { presentation: ThreadSyncPresentation }) {
  switch (presentation.tone) {
    case "busy":
      return (
        <LoaderCircleIcon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
      );
    case "success":
      return <CircleCheckIcon aria-hidden className="size-4" />;
    case "warning":
    case "error":
      return <TriangleAlertIcon aria-hidden className="size-4" />;
    default:
      return <GitCompareArrowsIcon aria-hidden className="size-4" />;
  }
}

function StatusSummary({ status }: { readonly status: ThreadSyncStatus }) {
  const items = [
    status.pendingPullCount > 0 ? `${status.pendingPullCount} remote` : null,
    status.pendingPushCount > 0 ? `${status.pendingPushCount} local` : null,
    status.conflicts.length > 0 ? `${status.conflicts.length} conflicts` : null,
    status.unlinkedProjects.length > 0
      ? `${status.unlinkedProjects.length} unlinked projects`
      : null,
  ].filter((item): item is string => item !== null);

  return (
    <div aria-live="polite" className="space-y-1">
      <p className="text-sm font-medium">
        {items.length === 0 ? "Thread history is up to date" : items.join(" · ")}
      </p>
      <p className="text-xs text-muted-foreground">{formatLastFetched(status.lastFetchedAt)}</p>
      {status.lastError ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/8 px-2 py-1.5 text-xs text-destructive-foreground">
          {status.lastError}
        </p>
      ) : null}
    </div>
  );
}

export function ThreadSyncPrivacyNotice() {
  return (
    <p
      className="flex gap-2 rounded-md border border-warning/25 bg-warning/8 px-2.5 py-2 text-[11px] leading-4 text-foreground"
      role="note"
    >
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <span>
        Use a dedicated private repository. Thread history and attachments are sent to this Git
        remote.
      </span>
    </p>
  );
}

function ThreadSyncConfigurationForm({
  status,
  disabled,
  onSubmit,
}: {
  readonly status: ThreadSyncStatus;
  readonly disabled: boolean;
  readonly onSubmit: (input: {
    readonly remoteUrl: string;
    readonly branch: string;
    readonly fetchIntervalSeconds: number;
  }) => Promise<void>;
}) {
  const configuredRemoteUrl = status.configuration?.remoteUrl ?? "";
  const configuredBranch = status.configuration?.branch ?? "main";
  const configuredInterval = status.configuration?.fetchIntervalSeconds ?? 300;
  const [remoteUrl, setRemoteUrl] = useState(configuredRemoteUrl);
  const [branch, setBranch] = useState(configuredBranch);
  const [interval, setInterval] = useState(String(configuredInterval));

  useEffect(() => {
    setRemoteUrl(configuredRemoteUrl);
    setBranch(configuredBranch);
    setInterval(String(configuredInterval));
  }, [configuredBranch, configuredInterval, configuredRemoteUrl]);

  const parsedInterval = Number(interval);
  const valid =
    remoteUrl.trim().length > 0 &&
    branch.trim().length > 0 &&
    Number.isInteger(parsedInterval) &&
    parsedInterval >= 15;

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        void onSubmit({
          remoteUrl: remoteUrl.trim(),
          branch: branch.trim(),
          fetchIntervalSeconds: parsedInterval,
        });
      }}
    >
      <label className="block space-y-1 text-xs font-medium">
        <span>Git remote</span>
        <Input
          aria-label="Thread sync Git remote"
          autoCapitalize="none"
          autoCorrect="off"
          disabled={disabled}
          onValueChange={setRemoteUrl}
          placeholder="git@github.com:you/erebus-threads.git"
          size="compact"
          spellCheck={false}
          value={remoteUrl}
        />
      </label>
      <div className="grid grid-cols-[1fr_6.5rem] gap-2">
        <label className="block space-y-1 text-xs font-medium">
          <span>Branch</span>
          <Input
            aria-label="Thread sync branch"
            autoCapitalize="none"
            disabled={disabled}
            onValueChange={setBranch}
            size="compact"
            spellCheck={false}
            value={branch}
          />
        </label>
        <label className="block space-y-1 text-xs font-medium">
          <span>Check every</span>
          <Input
            aria-label="Thread sync interval in seconds"
            disabled={disabled}
            inputMode="numeric"
            min={15}
            nativeInput
            onChange={(event) => setInterval(event.currentTarget.value)}
            size="compact"
            type="number"
            value={interval}
          />
        </label>
      </div>
      <p className="text-[11px] leading-4 text-muted-foreground">
        Syncs thread history only. Accounts, providers, models, and local project paths stay on this
        device.
      </p>
      <ThreadSyncPrivacyNotice />
      {status.lastError ? (
        <p
          className="rounded-md border border-destructive/30 bg-destructive/8 px-2 py-1.5 text-xs text-destructive-foreground"
          role="alert"
        >
          {status.lastError}
        </p>
      ) : null}
      <Button className="w-full" disabled={disabled || !valid} size="compact" type="submit">
        {status.configuration === null ? "Connect Git sync" : "Save connection"}
      </Button>
    </form>
  );
}

function ConflictDialog({
  mode,
  conflicts,
  open,
  pending,
  onOpenChange,
  onSubmit,
}: {
  readonly mode: "pull" | "push";
  readonly conflicts: ReadonlyArray<ThreadSyncConflict>;
  readonly open: boolean;
  readonly pending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (
    strategies: ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly resolution: ThreadSyncPullResolution | ThreadSyncPushResolution;
    }>,
  ) => Promise<void>;
}) {
  const fallback = mode === "pull" ? "use-remote" : "pull-remote";
  const [resolutions, setResolutions] = useState<
    Record<string, ThreadSyncPullResolution | ThreadSyncPushResolution>
  >({});

  useEffect(() => {
    if (!open) setResolutions({});
  }, [open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Resolve thread conflicts</DialogTitle>
          <DialogDescription>
            Choose each thread separately. “Keep both” imports a copy instead of overwriting either
            history.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[min(60vh,32rem)] space-y-3 overflow-y-auto">
          {conflicts.map((conflict) => {
            const value = resolutions[conflict.threadId] ?? fallback;
            return (
              <label className="block space-y-1.5" key={conflict.threadId}>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {conflict.title}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {conflict.threadId.slice(0, 8)}
                  </span>
                </span>
                <select
                  aria-label={`Resolution for ${conflict.title}, thread ${conflict.threadId}`}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  disabled={pending}
                  onChange={(event) => {
                    const resolution = event.currentTarget.value as
                      | ThreadSyncPullResolution
                      | ThreadSyncPushResolution;
                    setResolutions((current) =>
                      updateThreadSyncSelection(current, conflict.threadId, resolution),
                    );
                  }}
                  value={value}
                >
                  {mode === "pull" ? (
                    <>
                      <option value="use-remote">Use remote history</option>
                      <option value="keep-both">Keep both as separate threads</option>
                    </>
                  ) : (
                    <>
                      <option value="pull-remote">Use remote history</option>
                      <option value="keep-both">Keep both as separate threads</option>
                      <option value="replace-remote">Replace this remote thread</option>
                    </>
                  )}
                </select>
              </label>
            );
          })}
          {mode === "push" ? (
            <p className="text-xs leading-5 text-muted-foreground">
              Replacing remote history updates only the selected thread on top of the latest remote
              revision. It does not force-push the repository.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button disabled={pending} onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button
            aria-busy={pending || undefined}
            disabled={pending || conflicts.length === 0}
            onClick={() => void onSubmit(buildConflictStrategies(conflicts, resolutions, fallback))}
          >
            {mode === "pull" ? "Pull selected histories" : "Sync selected histories"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ProjectLinkDialog({
  environmentId,
  unlinkedProjects,
  projects,
  open,
  pending,
  onOpenChange,
  onLink,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly unlinkedProjects: ReadonlyArray<ThreadSyncUnlinkedProject>;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly open: boolean;
  readonly pending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onLink: (
    unlinked: ThreadSyncUnlinkedProject,
    project: OrchestrationProjectShell,
  ) => Promise<void>;
}) {
  const [selections, setSelections] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) setSelections({});
  }, [open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Link projects on this device</DialogTitle>
          <DialogDescription>
            Synced projects never carry host paths. Choose the local folder for each project before
            its threads are imported.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[min(60vh,32rem)] space-y-4 overflow-y-auto">
          {unlinkedProjects.map((unlinked) => {
            const suggestedId = projects.some(
              (project) => project.id === unlinked.suggestedProjectId,
            )
              ? unlinked.suggestedProjectId
              : null;
            const selectedId = selections[unlinked.project.syncProjectId] ?? suggestedId ?? "";
            const selected = projects.find((project) => project.id === selectedId) ?? null;
            return (
              <div
                className="space-y-2 rounded-lg border border-border p-3"
                key={unlinked.project.syncProjectId}
              >
                <div>
                  <p className="truncate text-sm font-medium">{unlinked.project.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {unlinked.reason === "ambiguous-match"
                      ? "More than one local project matched."
                      : unlinked.reason === "workspace-missing"
                        ? "The previous local folder is unavailable."
                        : "No local project matched."}
                  </p>
                </div>
                <div className="flex gap-2">
                  <select
                    aria-label={`Local project for ${unlinked.project.title}`}
                    className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    disabled={pending}
                    onChange={(event) => {
                      // React clears currentTarget after this callback. Snapshot the value before
                      // the concurrent state updater runs.
                      const projectId = event.currentTarget.value;
                      setSelections((current) =>
                        updateThreadSyncSelection(
                          current,
                          unlinked.project.syncProjectId,
                          projectId,
                        ),
                      );
                    }}
                    value={selectedId}
                  >
                    <option value="">Choose local project…</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.title} — {project.workspaceRoot}
                      </option>
                    ))}
                  </select>
                  <Button
                    disabled={pending || selected === null || environmentId === null}
                    onClick={() => selected && void onLink(unlinked, selected)}
                    size="compact"
                  >
                    Link
                  </Button>
                </div>
              </div>
            );
          })}
          <Button
            onClick={() => {
              onOpenChange(false);
              openCommandPalette({ open: "add-project" });
            }}
            size="compact"
            variant="outline"
          >
            <PlusIcon /> Add project
          </Button>
        </DialogPanel>
        <DialogFooter>
          <Button disabled={pending} onClick={() => onOpenChange(false)} variant="outline">
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function SidebarThreadSyncControl() {
  const environmentId = usePrimaryEnvironmentId();
  const status = useAtomValue(primaryThreadSyncStatusAtom);
  const allProjects = useAtomValue(environmentProjects.projectsAtom);
  const projects = useMemo(
    () =>
      environmentId === null
        ? []
        : allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const [dialog, setDialog] = useState<ThreadSyncDialog>(null);
  const [showConfiguration, setShowConfiguration] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const configure = useAtomCommand(threadSyncEnvironment.configure);
  const fetchRemote = useAtomCommand(threadSyncEnvironment.fetch);
  const pull = useAtomCommand(threadSyncEnvironment.pull);
  const push = useAtomCommand(threadSyncEnvironment.push);
  const disconnect = useAtomCommand(threadSyncEnvironment.disconnect);
  const linkProject = useAtomCommand(threadSyncEnvironment.linkProject);
  const presentation = getThreadSyncPresentation(status, environmentId !== null);
  const busy =
    pendingAction !== null ||
    (status !== null && !["idle", "error", "disconnected"].includes(status.state));

  const runAction = useCallback(async <T,>(name: string, action: () => Promise<T>): Promise<T> => {
    setPendingAction(name);
    try {
      return await action();
    } finally {
      setPendingAction(null);
    }
  }, []);

  const handleConfigure = useCallback(
    async (input: { remoteUrl: string; branch: string; fetchIntervalSeconds: number }) => {
      if (environmentId === null) return;
      const result = await runAction("configure", () => configure({ environmentId, input }));
      if (result._tag === "Success") {
        setShowConfiguration(false);
      }
    },
    [configure, environmentId, runAction],
  );

  const handleFetch = useCallback(async () => {
    if (environmentId === null || status === null) return;
    await runAction("fetch", () =>
      fetchRemote({
        environmentId,
        input: { expectedRemoteRevision: status.remoteRevision },
      }),
    );
  }, [environmentId, fetchRemote, runAction, status]);

  const handlePull = useCallback(
    async (
      strategies: ReadonlyArray<{
        threadId: ThreadId;
        resolution: ThreadSyncPullResolution | ThreadSyncPushResolution;
      }> = [],
    ) => {
      if (environmentId === null || status?.remoteRevision == null) return;
      const result = await runAction("pull", () =>
        pull({
          environmentId,
          input: {
            expectedRemoteRevision: status.remoteRevision,
            strategies: strategies.map(({ threadId, resolution }) => ({
              threadId,
              resolution: resolution as ThreadSyncPullResolution,
            })),
          },
        }),
      );
      if (result._tag === "Success") {
        setDialog(null);
      }
    },
    [environmentId, pull, runAction, status?.remoteRevision],
  );

  const handlePush = useCallback(
    async (
      strategies: ReadonlyArray<{
        threadId: ThreadId;
        resolution: ThreadSyncPullResolution | ThreadSyncPushResolution;
      }> = [],
    ) => {
      if (environmentId === null || status === null) return;
      const result = await runAction("push", () =>
        push({
          environmentId,
          input: buildThreadSyncPushInput(status.remoteRevision, strategies),
        }),
      );
      if (result._tag === "Success") {
        setDialog(null);
      }
    },
    [environmentId, push, runAction, status?.remoteRevision],
  );

  const handleLink = useCallback(
    async (unlinked: ThreadSyncUnlinkedProject, project: OrchestrationProjectShell) => {
      if (environmentId === null) return;
      await runAction("link-project", () =>
        linkProject({
          environmentId,
          input: {
            syncProjectId: unlinked.project.syncProjectId,
            projectId: project.id,
          },
        }),
      );
    },
    [environmentId, linkProject, runAction],
  );

  const handleDisconnect = useCallback(async () => {
    if (environmentId === null) return;
    const result = await runAction("disconnect", () =>
      disconnect({ environmentId, input: { removeLocalMirror: false } }),
    );
    if (result._tag === "Success") {
      setShowConfiguration(false);
    }
  }, [disconnect, environmentId, runAction]);

  const connected = status?.configuration !== null && status?.configuration !== undefined;

  return (
    <>
      <SidebarMenuItem className="shrink-0">
        <Popover>
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  aria-busy={presentation.tone === "busy" || undefined}
                  aria-label={presentation.label}
                  className={cn(
                    "inline-flex size-8 cursor-pointer items-center justify-center rounded-full outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2",
                    presentation.tone === "warning" && "text-warning",
                    presentation.tone === "error" && "text-destructive",
                    presentation.tone === "success" && "text-success",
                    ["idle", "busy"].includes(presentation.tone) &&
                      "text-[var(--sidebar-icon-color)] hover:text-sidebar-foreground",
                  )}
                >
                  <ThreadSyncStatusIcon presentation={presentation} />
                </PopoverTrigger>
              }
            />
            <TooltipPopup side="top">{presentation.label}</TooltipPopup>
          </Tooltip>
          <PopoverPopup align="start" className="w-80" side="top" sideOffset={6}>
            <div className="space-y-4">
              <div>
                <p className="text-sm font-semibold">Thread sync</p>
                <p className="text-xs text-muted-foreground">
                  Continue the same thread history on another device through Git.
                </p>
              </div>
              {environmentId === null ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  Connect to an environment before setting up thread sync.
                </p>
              ) : status === null ? (
                <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                  <LoaderCircleIcon
                    aria-hidden
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                  />
                  Loading sync state…
                </p>
              ) : !connected || showConfiguration ? (
                <ThreadSyncConfigurationForm
                  disabled={busy}
                  onSubmit={handleConfigure}
                  status={status}
                />
              ) : (
                <>
                  <StatusSummary status={status} />
                  <div className="grid grid-cols-3 gap-2">
                    <Button
                      aria-busy={pendingAction === "fetch" || undefined}
                      disabled={busy}
                      onClick={() => void handleFetch()}
                      size="compact"
                      variant="outline"
                    >
                      <RefreshCwIcon /> Check
                    </Button>
                    <Button
                      aria-busy={pendingAction === "pull" || undefined}
                      disabled={!canPullThreadSync(status, busy)}
                      onClick={() =>
                        status.conflicts.length > 0 ? setDialog("pull") : void handlePull()
                      }
                      size="compact"
                      variant="outline"
                    >
                      <ArrowDownToLineIcon /> Pull
                    </Button>
                    <Button
                      aria-busy={pendingAction === "push" || undefined}
                      disabled={!canPushThreadSync(status, busy)}
                      onClick={() =>
                        status.conflicts.length > 0 ? setDialog("push") : void handlePush()
                      }
                      size="compact"
                      variant="outline"
                    >
                      <ArrowUpFromLineIcon /> Push
                    </Button>
                  </div>
                  {status.unlinkedProjects.length > 0 ? (
                    <Button
                      className="w-full"
                      disabled={busy}
                      onClick={() => setDialog("projects")}
                      size="compact"
                      variant="outline"
                    >
                      <Link2Icon /> Link {status.unlinkedProjects.length} local project
                      {status.unlinkedProjects.length === 1 ? "" : "s"}
                    </Button>
                  ) : null}
                  <div className="flex items-center justify-between border-t border-border pt-3">
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
                      disabled={busy}
                      onClick={() => setShowConfiguration(true)}
                      type="button"
                    >
                      Edit connection
                    </button>
                    <button
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive disabled:opacity-60"
                      disabled={busy}
                      onClick={() => void handleDisconnect()}
                      type="button"
                    >
                      <UnplugIcon className="size-3" /> Disconnect
                    </button>
                  </div>
                </>
              )}
              {connected && showConfiguration ? (
                <button
                  className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
                  disabled={busy}
                  onClick={() => setShowConfiguration(false)}
                  type="button"
                >
                  Cancel editing
                </button>
              ) : null}
            </div>
          </PopoverPopup>
        </Popover>
      </SidebarMenuItem>
      <ConflictDialog
        conflicts={status?.conflicts ?? []}
        mode="pull"
        onOpenChange={(open) => setDialog(open ? "pull" : null)}
        onSubmit={handlePull}
        open={dialog === "pull"}
        pending={pendingAction !== null}
      />
      <ConflictDialog
        conflicts={status?.conflicts ?? []}
        mode="push"
        onOpenChange={(open) => setDialog(open ? "push" : null)}
        onSubmit={handlePush}
        open={dialog === "push"}
        pending={pendingAction !== null}
      />
      <ProjectLinkDialog
        environmentId={environmentId}
        onLink={handleLink}
        onOpenChange={(open) => setDialog(open ? "projects" : null)}
        open={dialog === "projects"}
        pending={pendingAction !== null}
        projects={projects}
        unlinkedProjects={status?.unlinkedProjects ?? []}
      />
    </>
  );
}
