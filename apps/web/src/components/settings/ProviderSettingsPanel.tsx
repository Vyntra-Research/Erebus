import { useAtomValue } from "@effect/atom-react";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import {
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Result from "effect/Result";
import {
  ChevronDownIcon,
  CloudIcon,
  CopyIcon,
  ExternalLinkIcon,
  LaptopIcon,
  LoaderIcon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
  TerminalIcon,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { isElectron } from "../../env";
import { readLocalApi } from "../../localApi";
import { usePrimarySessionState } from "../../environments/primary";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { getRelativeTimeState } from "../../timestampFormat";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateActive,
  type ProviderUpdateCandidate,
} from "../ProviderUpdateLaunchNotification.logic";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { ScrollArea } from "../ui/scroll-area";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";
import { providerSettingsTabClassName } from "./providerSettingsTabs";
import { searchableSetting } from "./settingsSearch";
import {
  backgroundActivityOverrideSettings,
  buildProviderInstanceUpdatePatch,
  durationToSeconds,
  normalizeIntervalSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
} from "./SettingsPanels.logic";
import {
  PolicyTooltip,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import {
  buildProviderEnvironmentOptions,
  classifyProviderEnvironmentAccess,
  type ProviderEnvironmentAccess,
  type ProviderOperateAccess,
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
  resolveSelectedProviderEnvironmentId,
} from "./ProviderSettingsPanel.logic";

function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[key];
  return next;
}

function withoutProviderInstanceFavorites(
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  instanceId: ProviderInstanceId,
) {
  return favorites.filter((favorite) => favorite.provider !== instanceId);
}

const PROVIDER_SETTINGS = DRIVER_OPTIONS.map((definition) => ({
  provider: definition.value,
}));

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  const lastCheckedRelative = getRelativeTimeState(lastCheckedAt);

  if (lastCheckedRelative.status === "missing") {
    return null;
  }

  if (lastCheckedRelative.status === "invalid") {
    return <span className="text-[11px] text-muted-foreground/50">Checked unavailable</span>;
  }

  return (
    <span className="text-[11px] text-muted-foreground/60">
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

type CodexLoginUiState =
  | { readonly instanceId: ProviderInstanceId; readonly status: "starting" }
  | {
      readonly instanceId: ProviderInstanceId;
      readonly status: "browserAuth";
      readonly authUrl: string;
    }
  | {
      readonly instanceId: ProviderInstanceId;
      readonly status: "waiting";
      readonly userCode: string;
      readonly verificationUrl: string;
    }
  | {
      readonly instanceId: ProviderInstanceId;
      readonly status: "failed";
      readonly message: string;
    };

function CodexLoginDialog({
  open,
  state,
  onOpenChange,
  onRetry,
}: {
  readonly open: boolean;
  readonly state: CodexLoginUiState | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRetry: () => void;
}) {
  if (!state) return null;

  const copyCode = async () => {
    if (state.status !== "waiting") return;
    await navigator.clipboard.writeText(state.userCode);
    toastManager.add({ type: "success", title: "Device code copied" });
  };
  const openVerification = () => {
    const url =
      state.status === "browserAuth"
        ? state.authUrl
        : state.status === "waiting"
          ? state.verificationUrl
          : null;
    if (!url) return;
    void readLocalApi()?.shell.openExternal(url);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen || state.status === "failed") onOpenChange(nextOpen);
      }}
    >
      <DialogPopup
        className="w-[min(28rem,calc(100vw-2rem))]"
        showCloseButton={state.status === "failed"}
      >
        <DialogHeader>
          <DialogTitle>Sign in to Codex</DialogTitle>
          <DialogDescription>
            Erebus uses Codex's browser login and stores the session only in this provider's
            isolated profile.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 px-6 pb-6">
          {state.status === "starting" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/30 p-4 text-sm text-muted-foreground">
              <LoaderIcon className="size-4 animate-spin" />
              Starting Codex sign-in…
            </div>
          ) : null}
          {state.status === "waiting" ? (
            <>
              <div className="rounded-lg border border-border/70 bg-muted/30 p-4 text-center">
                <p className="text-xs text-muted-foreground">Enter this one-time code</p>
                <code className="mt-2 block select-all text-2xl font-semibold tracking-[0.18em] text-foreground">
                  {state.userCode}
                </code>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant="outline" onClick={() => void copyCode()}>
                  <CopyIcon />
                  Copy code
                </Button>
                <Button type="button" onClick={openVerification}>
                  <ExternalLinkIcon />
                  Open ChatGPT
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Finish authorization in the browser. This window updates automatically.
              </p>
            </>
          ) : null}
          {state.status === "browserAuth" ? (
            <>
              <div className="rounded-lg border border-border/70 bg-muted/30 p-4 text-sm">
                <p className="font-medium text-foreground">Continue in your browser</p>
                <p className="mt-1 text-muted-foreground">
                  Sign in to the ChatGPT account for this provider. Erebus will finish setup when
                  Codex receives the callback.
                </p>
              </div>
              <Button type="button" onClick={openVerification}>
                <ExternalLinkIcon />
                Open ChatGPT
              </Button>
            </>
          ) : null}
          {state.status === "failed" ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
              {state.message}
            </div>
          ) : null}
        </div>

        {state.status === "failed" ? (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button type="button" onClick={onRetry}>
              Try again
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function providerEnvironmentIcon(environment: EnvironmentPresentation) {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return MonitorIcon;
  if (environment.entry.target._tag === "RelayConnectionTarget") return CloudIcon;
  if (environment.entry.target._tag === "SshConnectionTarget") return TerminalIcon;
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return LaptopIcon;
  return CloudIcon;
}

function providerEnvironmentDetail(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Primary device";
  if (environment.relayManaged) return "Erebus Connect";
  if (environment.entry.target._tag === "SshConnectionTarget") return "SSH";
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return "Local device";
  return environment.displayUrl ?? "Remote device";
}

function EnvironmentUnavailableRow({
  environment,
  access,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly access: Exclude<ProviderEnvironmentAccess, { kind: "editable" | "read-only" }>;
  readonly deviceTabs?: ReactNode;
}) {
  const isLoading = access.kind === "loading";
  const title = isLoading
    ? "Loading provider settings"
    : access.kind === "error"
      ? "Could not connect to this device"
      : "Provider settings are unavailable";
  const description = isLoading
    ? access.reason === "permissions"
      ? "Checking what this session is allowed to change."
      : `Waiting for ${environment.label}'s configuration.`
    : connectionStatusText(environment.connection);
  // No spinner: this state can persist indefinitely for a wedged device, and a
  // continuously repainting animation would run the whole time.
  return (
    <SettingsSection title="Providers">
      {deviceTabs}
      <SettingsRow title={title} description={description} />
    </SettingsSection>
  );
}

export function ProviderSettingsPanel() {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const options = useMemo(
    () => buildProviderEnvironmentOptions(environments, primaryEnvironmentId),
    [environments, primaryEnvironmentId],
  );
  // Raw user intent; the effective selection is re-derived every render so a
  // device that drops out of the catalog falls back without erasing the pick —
  // if it reappears (e.g. after a reconnect) the selection is restored.
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    primaryEnvironmentId,
  );
  const effectiveEnvironmentId = resolveSelectedProviderEnvironmentId(
    options,
    selectedEnvironmentId,
    primaryEnvironmentId,
  );
  const selectedEnvironment =
    options.find((environment) => environment.environmentId === effectiveEnvironmentId) ?? null;
  const onlyPrimaryDevice =
    options.length === 1 && options[0]?.entry.target._tag === "PrimaryConnectionTarget";
  const deviceTabs =
    !onlyPrimaryDevice && options.length > 0 ? (
      <ScrollArea hideScrollbars scrollFade className="h-11 min-w-0 rounded-none">
        <div
          role="group"
          aria-label="Devices"
          className="flex h-full w-max min-w-full border-b border-border/70 px-3 sm:px-4"
        >
          {options.map((environment) => {
            const Icon = providerEnvironmentIcon(environment);
            const selected = environment.environmentId === effectiveEnvironmentId;
            const detail = providerEnvironmentDetail(environment);
            const statusText = connectionStatusText(environment.connection);
            return (
              <Tooltip key={environment.environmentId}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-pressed={selected}
                      className={cn(providerSettingsTabClassName(selected), "gap-2 text-left")}
                      onClick={() => setSelectedEnvironmentId(environment.environmentId)}
                    >
                      <Icon className="size-3.5 shrink-0" aria-hidden />
                      <span className="max-w-40 truncate">{environment.label}</span>
                      <ConnectionStatusDot
                        dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                        pingClassName={connectionPhasePingClassName(environment.connection.phase)}
                      />
                      <span className="sr-only">
                        {detail}, {statusText}
                      </span>
                    </button>
                  }
                />
                <TooltipPopup side="top">
                  {detail} · {statusText}
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </div>
      </ScrollArea>
    ) : null;

  return (
    <SettingsPageContainer width="expanded" className="gap-8">
      {options.length === 0 ? (
        <SettingsSection title="Providers">
          <SettingsRow
            title={isReady ? "No connected devices" : "Loading devices"}
            description={
              isReady
                ? "Connect an execution environment before configuring providers."
                : "Reading connected execution environments."
            }
          />
        </SettingsSection>
      ) : null}

      {selectedEnvironment ? (
        <SelectedEnvironmentProviderSettings
          key={selectedEnvironment.environmentId}
          environment={selectedEnvironment}
          deviceTabs={deviceTabs}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function SelectedEnvironmentProviderSettings({
  environment,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
}) {
  const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
  if (isPrimary) {
    // The desktop app owns its primary server outright; a browser session
    // checks the scopes its cookie session was granted.
    if (isElectron) {
      return (
        <AccessGatedProviderSettings
          environment={environment}
          operateAccess="granted"
          deviceTabs={deviceTabs}
        />
      );
    }
    return (
      <PrimarySessionGatedProviderSettings environment={environment} deviceTabs={deviceTabs} />
    );
  }
  return <RemoteSessionGatedProviderSettings environment={environment} deviceTabs={deviceTabs} />;
}

function PrimarySessionGatedProviderSettings({
  environment,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
}) {
  const primarySessionState = usePrimarySessionState();
  const operateAccess = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: false,
    session: primarySessionState.data,
    isPending: primarySessionState.isPending,
    hasError: primarySessionState.error !== null,
  });
  return (
    <AccessGatedProviderSettings
      environment={environment}
      operateAccess={operateAccess}
      deviceTabs={deviceTabs}
    />
  );
}

function RemoteSessionGatedProviderSettings({
  environment,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
}) {
  const sessionState = useEnvironmentSessionState(environment.environmentId);
  const operateAccess = resolveRemoteOperateAccess({
    session: sessionState.data,
    isPending: sessionState.isPending,
    hasError: sessionState.hasError,
  });
  return (
    <AccessGatedProviderSettings
      environment={environment}
      operateAccess={operateAccess}
      deviceTabs={deviceTabs}
    />
  );
}

function AccessGatedProviderSettings({
  environment,
  operateAccess,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly operateAccess: ProviderOperateAccess;
  readonly deviceTabs?: ReactNode;
}) {
  const access = classifyProviderEnvironmentAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess,
  });
  if (access.kind !== "editable" && access.kind !== "read-only") {
    return (
      <EnvironmentUnavailableRow
        environment={environment}
        access={access}
        deviceTabs={deviceTabs}
      />
    );
  }
  return (
    <EnvironmentProviderSettings
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
      readOnly={access.kind === "read-only"}
      deviceTabs={deviceTabs}
    />
  );
}

export function EnvironmentProviderSettings({
  environmentId,
  environmentLabel,
  readOnly = false,
  deviceTabs,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly deviceTabs?: ReactNode;
  /**
   * Render the full provider layout, greyed out and inert, when this session's
   * credential lacks `orchestration:operate` on the environment. Showing the
   * real configuration keeps the view honest; disabling interaction keeps
   * every one of its writes from being offered and then rejected.
   */
  readonly readOnly?: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const loginCodex = useAtomCommand(serverEnvironment.loginCodex, {
    reportFailure: false,
  });
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | null>(null);
  const [codexLoginState, setCodexLoginState] = useState<CodexLoginUiState | null>(null);
  const [codexLoginDialogOpen, setCodexLoginDialogOpen] = useState(false);
  const [loggingInInstanceIds, setLoggingInInstanceIds] = useState<ReadonlySet<ProviderInstanceId>>(
    () => new Set(),
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedVisible = readOnly || advancedOpen;
  const [updatingProviderDrivers, setUpdatingProviderDrivers] = useState<
    ReadonlySet<ProviderDriverKind>
  >(() => new Set());
  const refreshingRef = useRef(false);
  const updatingDriversRef = useRef<Set<ProviderDriverKind>>(new Set());
  const loggingInInstancesRef = useRef<Set<ProviderInstanceId>>(new Set());
  const openedCodexLoginIdsRef = useRef<Set<string>>(new Set());

  const providerUpdateCandidates = useMemo(
    () => collectProviderUpdateCandidates(serverProviders),
    [serverProviders],
  );
  const providerUpdateCandidateByDriver = useMemo(
    () => new Map(providerUpdateCandidates.map((candidate) => [candidate.driver, candidate])),
    [providerUpdateCandidates],
  );
  const visibleProviderSettings = PROVIDER_SETTINGS.filter(
    (providerSettings) =>
      providerSettings.provider !== "cursor" ||
      serverProviders.some(
        (provider) =>
          provider.instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("cursor")),
      ),
  );
  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const providerHealthPreset = getBackgroundActivityPresetSettings(
    resolvedBackgroundActivity.profile,
  ).providerHealthRefreshInterval;
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const defaultProviderHealthRefreshIntervalSeconds = durationToSeconds(providerHealthPreset);
  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void (async () => {
      const result = await refreshServerProviders({
        environmentId,
        input: {},
      });
      refreshingRef.current = false;
      setIsRefreshingProviders(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        console.warn("Failed to refresh providers", {
          operation: "refresh-providers",
          environmentId,
          ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
        });
      }
    })();
  }, [environmentId, refreshServerProviders]);

  const startCodexLogin = useCallback(
    async (instanceId: ProviderInstanceId) => {
      if (loggingInInstancesRef.current.has(instanceId)) {
        setCodexLoginDialogOpen(true);
        return;
      }

      loggingInInstancesRef.current.add(instanceId);
      setLoggingInInstanceIds((previous) => new Set(previous).add(instanceId));
      setCodexLoginState({ instanceId, status: "starting" });
      setCodexLoginDialogOpen(true);

      const result = await loginCodex({
        environmentId,
        input: { instanceId },
        onProgress: (event) => {
          if (event.type === "complete") return;
          const url = event.type === "browserAuth" ? event.authUrl : event.verificationUrl;
          setCodexLoginState(
            event.type === "browserAuth"
              ? { instanceId, status: "browserAuth", authUrl: event.authUrl }
              : {
                  instanceId,
                  status: "waiting",
                  userCode: event.userCode,
                  verificationUrl: event.verificationUrl,
                },
          );
          setCodexLoginDialogOpen(true);
          if (!openedCodexLoginIdsRef.current.has(event.loginId)) {
            openedCodexLoginIdsRef.current.add(event.loginId);
            void readLocalApi()
              ?.shell.openExternal(url)
              .catch((error) => console.warn("Could not open Codex login URL", error));
          }
        },
      });

      loggingInInstancesRef.current.delete(instanceId);
      setLoggingInInstanceIds((previous) => {
        const next = new Set(previous);
        next.delete(instanceId);
        return next;
      });

      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        setCodexLoginState({
          instanceId,
          status: "failed",
          message: error instanceof Error ? error.message : "Codex sign-in failed.",
        });
        setCodexLoginDialogOpen(true);
        return;
      }

      setCodexLoginState(null);
      setCodexLoginDialogOpen(false);
      toastManager.add({ type: "success", title: "Signed in to Codex" });
      await refreshServerProviders({ environmentId, input: { instanceId } });
    },
    [environmentId, loginCodex, refreshServerProviders],
  );

  const runProviderUpdate = useCallback(
    async (candidate: ProviderUpdateCandidate) => {
      // Ref-based re-entry guard, mirroring refreshProviders: a state updater
      // may run after this function returns, so it cannot gate the dispatch.
      if (updatingDriversRef.current.has(candidate.driver)) {
        return;
      }
      updatingDriversRef.current.add(candidate.driver);
      setUpdatingProviderDrivers((previous) => new Set(previous).add(candidate.driver));

      const result = await updateProvider({
        environmentId,
        input: {
          provider: candidate.driver,
          instanceId: candidate.instanceId,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not update ${PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver}`,
            description:
              error instanceof Error
                ? error.message
                : "The provider update command could not be started.",
          }),
        );
      }
      updatingDriversRef.current.delete(candidate.driver);
      setUpdatingProviderDrivers((previous) => {
        if (!previous.has(candidate.driver)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(candidate.driver);
        return next;
      });
    },
    [environmentId, updateProvider],
  );

  interface InstanceRow {
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
    readonly driver: ProviderDriverKind;
    readonly isDefault: boolean;
    readonly isDirty?: boolean;
  }

  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const rows: InstanceRow[] = [];

  for (const providerSettings of visibleProviderSettings) {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const legacyProviders = settings.providers as Record<string, LegacyProviderSettings>;
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings
    >;
    const driver = providerSettings.provider;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    // A remote device may run a server version whose settings predate this
    // driver, so the legacy mirror can be absent. Without either an explicit
    // instance or a legacy blob there is nothing to render for the slot.
    const legacyConfig = legacyProviders[providerSettings.provider];
    const defaultLegacyConfig = defaultLegacyProviders[providerSettings.provider];
    // The envelope is the single enabled flag: keep the legacy in-config
    // flag out of the synthesized blob, or an explicit `enabled: false`
    // would keep winning over the envelope and the Switch could never
    // turn a default-off provider on.
    const synthesizedInstance = (): ProviderInstanceConfig | undefined => {
      if (legacyConfig === undefined) {
        return undefined;
      }
      const { enabled: legacyEnabled, ...legacyConfigRest } = legacyConfig;
      return {
        driver,
        enabled: legacyEnabled,
        config: legacyConfigRest,
      } satisfies ProviderInstanceConfig;
    };
    const effectiveInstance: ProviderInstanceConfig | undefined =
      explicitInstance ?? synthesizedInstance();
    // Only the default slot depends on the legacy blob; custom instances for
    // the driver must still render even when the slot has nothing to show.
    if (effectiveInstance !== undefined) {
      const isDirty =
        explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig);
      rows.push({
        instanceId: defaultInstanceId,
        instance: effectiveInstance,
        driver,
        isDefault: true,
        isDirty,
      });
    }
    for (const [id, instance] of instancesByDriver.get(providerSettings.provider) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({ instanceId: id, instance, driver: instance.driver, isDefault: false });
    }
  }
  const codexRows = rows.filter((row) => row.driver === "codex");
  const configuredPrimaryInstanceId = settings.codexAccountRouting.primaryInstanceId;
  const primaryCodexInstanceId =
    codexRows.find((row) => row.instanceId === configuredPrimaryInstanceId)?.instanceId ??
    codexRows.find((row) => row.isDefault)?.instanceId ??
    codexRows[0]?.instanceId ??
    null;
  const selectedRow = rows.find((row) => row.instanceId === selectedInstanceId) ?? rows[0] ?? null;

  const updateProviderInstance = (
    row: InstanceRow,
    next: ProviderInstanceConfig,
    options?: {
      readonly textGenerationModelSelection?: Parameters<
        typeof buildProviderInstanceUpdatePatch
      >[0]["textGenerationModelSelection"];
    },
  ) => {
    updateSettings(
      buildProviderInstanceUpdatePatch({
        settings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
        textGenerationModelSelection: options?.textGenerationModelSelection,
      }),
    );
  };

  const deleteProviderInstance = (id: ProviderInstanceId) => {
    const remainingCodexRows = codexRows.filter((row) => row.instanceId !== id);
    const nextPrimaryInstanceId =
      primaryCodexInstanceId === id
        ? (remainingCodexRows.find((row) => row.isDefault)?.instanceId ??
          remainingCodexRows[0]?.instanceId ??
          null)
        : settings.codexAccountRouting.primaryInstanceId;
    updateSettings({
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, id),
      codexAccountRouting: {
        ...settings.codexAccountRouting,
        primaryInstanceId: nextPrimaryInstanceId,
      },
    });
  };

  const setPrimaryCodexInstance = (instanceId: ProviderInstanceId) => {
    updateSettings({
      codexAccountRouting: {
        ...settings.codexAccountRouting,
        primaryInstanceId: instanceId,
      },
    });
  };

  const updateProviderModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderInstanceKey(settings.providerModelPreferences, instanceId);
    updateSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : {
              ...rest,
              [instanceId]: {
                hiddenModels,
                modelOrder,
              },
            },
    });
  };

  const updateProviderFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(
        Arr.filterMap(nextFavoriteModels, (slug) => {
          const trimmedSlug = slug.trim();
          return trimmedSlug.length > 0 ? Result.succeed(trimmedSlug) : Result.failVoid;
        }),
      ),
    ];
    updateSettings({
      favorites: [
        ...withoutProviderInstanceFavorites(settings.favorites ?? [], instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  const resetDefaultInstance = (driverKind: ProviderDriverKind) => {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings | undefined
    >;
    const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
    const defaultLegacyProvider = defaultLegacyProviders[driverKind];
    if (defaultLegacyProvider === undefined) return;
    updateSettings({
      providers: {
        ...settings.providers,
        [driverKind]: defaultLegacyProvider,
      } as typeof settings.providers,
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, defaultInstanceId),
    });
  };

  const renderProviderInstance = (row: InstanceRow, mode: "list" | "editor") => {
    const driverOption = getDriverOption(row.driver);
    const liveProvider = serverProviders.find(
      (candidate) => candidate.instanceId === row.instanceId,
    );
    const driverUpdateCandidate = providerUpdateCandidateByDriver.get(row.driver);
    const isRuntimeUpdateOwner =
      row.driver !== "codex" || row.instanceId === primaryCodexInstanceId;
    const updateCandidate = isRuntimeUpdateOwner ? driverUpdateCandidate : undefined;
    const isDriverUpdateRunning =
      updateCandidate !== undefined &&
      (updatingProviderDrivers.has(updateCandidate.driver) ||
        serverProviders.some(
          (provider) =>
            provider.driver === updateCandidate.driver && isProviderUpdateActive(provider),
        ));
    const showInlineUpdateButton =
      updateCandidate !== undefined &&
      hasOneClickUpdateProviderCandidate(updateCandidate, serverProviders);
    const canRunInlineUpdate =
      updateCandidate !== undefined &&
      canOneClickUpdateProviderCandidate(updateCandidate, serverProviders) &&
      !updatingProviderDrivers.has(updateCandidate.driver);
    const modelPreferences = settings.providerModelPreferences?.[row.instanceId] ?? {
      hiddenModels: [],
      modelOrder: [],
    };
    const favoriteModels = Arr.filterMap(settings.favorites ?? [], (favorite) =>
      favorite.provider === row.instanceId ? Result.succeed(favorite.model) : Result.failVoid,
    );
    const resetLabel = driverOption?.label ?? String(row.driver);

    return (
      <ProviderInstanceCard
        key={row.instanceId}
        instanceId={row.instanceId}
        instance={row.instance}
        driverOption={driverOption}
        liveProvider={liveProvider}
        mode={mode}
        selected={mode === "list" && selectedRow?.instanceId === row.instanceId}
        onSelect={mode === "list" ? () => setSelectedInstanceId(row.instanceId) : undefined}
        readOnly={readOnly}
        onUpdate={(next) => {
          const wasEnabled = resolveProviderInstanceEnabled(row.instance);
          const isDisabling = next.enabled === false && wasEnabled;
          const shouldClearTextGen = isDisabling && textGenInstanceId === row.instanceId;
          updateProviderInstance(
            row,
            next,
            shouldClearTextGen
              ? {
                  textGenerationModelSelection:
                    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                }
              : undefined,
          );
        }}
        onDelete={
          mode === "editor" && !row.isDefault
            ? () => deleteProviderInstance(row.instanceId)
            : undefined
        }
        headerAction={
          mode === "editor" && row.isDefault && row.isDirty ? (
            <SettingResetButton
              label={`${resetLabel} provider settings`}
              onClick={() => resetDefaultInstance(row.driver)}
            />
          ) : null
        }
        hiddenModels={modelPreferences.hiddenModels}
        favoriteModels={favoriteModels}
        modelOrder={modelPreferences.modelOrder}
        onHiddenModelsChange={(hiddenModels) =>
          updateProviderModelPreferences(row.instanceId, {
            ...modelPreferences,
            hiddenModels,
          })
        }
        onFavoriteModelsChange={(next) => updateProviderFavoriteModels(row.instanceId, next)}
        onModelOrderChange={(modelOrder) =>
          updateProviderModelPreferences(row.instanceId, {
            ...modelPreferences,
            modelOrder,
          })
        }
        onRunUpdate={
          mode === "editor" && showInlineUpdateButton && updateCandidate
            ? () => {
                if (canRunInlineUpdate) void runProviderUpdate(updateCandidate);
              }
            : undefined
        }
        isUpdating={mode === "editor" && showInlineUpdateButton ? isDriverUpdateRunning : undefined}
        showRuntimeUpdate={isRuntimeUpdateOwner}
        onLogin={
          mode === "editor" && row.driver === "codex"
            ? () => void startCodexLogin(row.instanceId)
            : undefined
        }
        isLoggingIn={loggingInInstanceIds.has(row.instanceId)}
        isPrimaryAccount={row.driver === "codex" && row.instanceId === primaryCodexInstanceId}
        onSetPrimaryAccount={
          mode === "editor" && row.driver === "codex" && row.instanceId !== primaryCodexInstanceId
            ? () => setPrimaryCodexInstance(row.instanceId)
            : undefined
        }
      />
    );
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("providers")}
        headerAction={
          !readOnly ? (
            <Button
              size="compact"
              variant="outline"
              onClick={() => setIsAddInstanceDialogOpen(true)}
            >
              <PlusIcon className="size-3.5" />
              Add Codex account
            </Button>
          ) : null
        }
      >
        {deviceTabs}
        {readOnly ? (
          <SettingsRow
            title="Limited permissions"
            description={`This session can view ${environmentLabel}'s providers, but its credential does not allow changing their configuration.`}
          />
        ) : null}
        <div className="space-y-1">
          <div className="overflow-hidden rounded-lg border border-border/70 lg:grid lg:grid-cols-[20rem_minmax(0,1fr)]">
            <div className="border-b border-border/70 lg:border-r lg:border-b-0">
              <div className="flex min-h-9 items-center justify-between border-b border-border/70 px-3 text-[11px] font-medium text-muted-foreground">
                <span>Provider</span>
                <span>On</span>
              </div>
              {rows.map((row) => renderProviderInstance(row, "list"))}
              <div className="flex min-h-10 items-center justify-between px-3">
                <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
                {!readOnly ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-micro"
                          variant="ghost-muted"
                          disabled={isRefreshingProviders}
                          onClick={() => void refreshProviders()}
                          aria-label="Refresh provider status"
                        >
                          {isRefreshingProviders ? (
                            <LoaderIcon className="size-3 animate-spin" />
                          ) : (
                            <RefreshCwIcon className="size-3" />
                          )}
                        </Button>
                      }
                    />
                    <TooltipPopup side="top">Refresh provider status</TooltipPopup>
                  </Tooltip>
                ) : null}
              </div>
            </div>

            <div className="min-w-0">
              {selectedRow ? (
                renderProviderInstance(selectedRow, "editor")
              ) : (
                <div className="p-6 text-sm text-muted-foreground">No providers configured.</div>
              )}
            </div>
          </div>

          <div
            inert={readOnly}
            aria-disabled={readOnly || undefined}
            className={readOnly ? "opacity-50 select-none" : undefined}
          >
            <Collapsible
              open={advancedVisible}
              onOpenChange={setAdvancedOpen}
              className="mt-2 border-t border-border/70"
            >
              <CollapsibleTrigger className="flex h-10 w-full items-center gap-2 px-3 text-xs text-muted-foreground hover:text-foreground sm:px-4">
                <ChevronDownIcon
                  className={cn("size-3 transition-transform", advancedVisible && "rotate-180")}
                />
                Advanced
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SettingsRow
                  title={
                    <span className="inline-flex items-center gap-1.5">
                      Health check interval
                      <PolicyTooltip>
                        This interval is configured here, then the shared Background activity policy
                        decides whether provider probes may run when the timer fires. Custom
                        intervals appear as Advanced in General settings.
                      </PolicyTooltip>
                    </span>
                  }
                  description="Set this to 0 seconds to use manual refresh only."
                  resetAction={
                    providerHealthRefreshIntervalSeconds !==
                    defaultProviderHealthRefreshIntervalSeconds ? (
                      <SettingResetButton
                        label="provider health check interval"
                        onClick={() =>
                          updateSettings(
                            backgroundActivityOverrideSettings(
                              settings.backgroundActivity,
                              resolvedBackgroundActivity,
                              { providerHealthRefreshInterval: undefined },
                            ),
                          )
                        }
                      />
                    ) : null
                  }
                  control={
                    <div className="flex shrink-0 items-center gap-2">
                      <NumberField
                        value={providerHealthRefreshIntervalSeconds}
                        min={0}
                        step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                        size="sm"
                        className="w-32"
                        onValueChange={(value) =>
                          updateSettings(
                            backgroundActivityOverrideSettings(
                              settings.backgroundActivity,
                              resolvedBackgroundActivity,
                              {
                                providerHealthRefreshInterval: Duration.seconds(
                                  normalizeIntervalSeconds(value),
                                ),
                              },
                            ),
                          )
                        }
                      >
                        <NumberFieldGroup>
                          <NumberFieldDecrement aria-label="Decrease provider health check interval" />
                          <NumberFieldInput aria-label="Provider health check interval in seconds" />
                          <NumberFieldIncrement aria-label="Increase provider health check interval" />
                        </NumberFieldGroup>
                      </NumberField>
                      <span className="text-xs text-muted-foreground">seconds</span>
                    </div>
                  }
                />
                <SettingsRow
                  title="Automatic Codex account routing"
                  description="Keep the primary account preferred and move new turns to another signed-in account when its quota runs low."
                  control={
                    <Switch
                      checked={settings.codexAccountRouting.enabled}
                      onCheckedChange={(enabled) =>
                        updateSettings({
                          codexAccountRouting: {
                            ...settings.codexAccountRouting,
                            enabled: Boolean(enabled),
                          },
                        })
                      }
                      aria-label="Enable automatic Codex account routing"
                    />
                  }
                />
                <SettingsRow
                  title="Primary account switch point"
                  description="Move to the next account when the primary account reaches this remaining quota."
                  control={
                    <div className="flex shrink-0 items-center gap-2">
                      <NumberField
                        value={settings.codexAccountRouting.primarySwitchRemainingPercent}
                        min={0}
                        max={100}
                        step={1}
                        size="sm"
                        className="w-28"
                        onValueChange={(value) =>
                          updateSettings({
                            codexAccountRouting: {
                              ...settings.codexAccountRouting,
                              primarySwitchRemainingPercent: Math.max(
                                0,
                                Math.min(100, Math.round(value ?? 0)),
                              ),
                            },
                          })
                        }
                      >
                        <NumberFieldGroup>
                          <NumberFieldDecrement aria-label="Decrease primary switch point" />
                          <NumberFieldInput aria-label="Primary account switch point" />
                          <NumberFieldIncrement aria-label="Increase primary switch point" />
                        </NumberFieldGroup>
                      </NumberField>
                      <span className="text-xs text-muted-foreground">% left</span>
                    </div>
                  }
                />
                <SettingsRow
                  title="Fallback reserve"
                  description="Recheck higher-priority accounts when the active fallback reaches this remaining quota."
                  control={
                    <div className="flex shrink-0 items-center gap-2">
                      <NumberField
                        value={settings.codexAccountRouting.fallbackReserveRemainingPercent}
                        min={0}
                        max={100}
                        step={1}
                        size="sm"
                        className="w-28"
                        onValueChange={(value) =>
                          updateSettings({
                            codexAccountRouting: {
                              ...settings.codexAccountRouting,
                              fallbackReserveRemainingPercent: Math.max(
                                0,
                                Math.min(100, Math.round(value ?? 0)),
                              ),
                            },
                          })
                        }
                      >
                        <NumberFieldGroup>
                          <NumberFieldDecrement aria-label="Decrease fallback reserve" />
                          <NumberFieldInput aria-label="Fallback reserve" />
                          <NumberFieldIncrement aria-label="Increase fallback reserve" />
                        </NumberFieldGroup>
                      </NumberField>
                      <span className="text-xs text-muted-foreground">% left</span>
                    </div>
                  }
                />
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>
      </SettingsSection>

      {isAddInstanceDialogOpen ? (
        <AddProviderInstanceDialog
          open
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          onOpenChange={setIsAddInstanceDialogOpen}
        />
      ) : null}
      <CodexLoginDialog
        open={codexLoginDialogOpen}
        state={codexLoginState}
        onOpenChange={setCodexLoginDialogOpen}
        onRetry={() => {
          const instanceId = codexLoginState?.instanceId;
          if (instanceId) void startCodexLogin(instanceId);
        }}
      />
    </>
  );
}
