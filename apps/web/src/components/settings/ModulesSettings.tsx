import {
  type ServerModuleId,
  type ServerModuleStatus,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { BoxesIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type PentestModuleId = Exclude<ServerModuleId, "argos">;

const MODULE_ORDER: ReadonlyArray<ServerModuleId> = ["argos", "secrethound", "katana", "subfinder"];

const MODULE_FALLBACKS: Readonly<
  Record<ServerModuleId, Pick<ServerModuleStatus, "displayName" | "description">>
> = {
  argos: {
    displayName: "Argos",
    description: "Connected research memory and knowledge graph.",
  },
  secrethound: {
    displayName: "SecretHound",
    description: "Find secrets and sensitive values in web assets.",
  },
  katana: {
    displayName: "Katana",
    description: "Crawl web targets and return structured routes and parameters.",
  },
  subfinder: {
    displayName: "Subfinder",
    description: "Enumerate subdomains from passive sources.",
  },
};

type PentestModulePatch = NonNullable<
  NonNullable<ServerSettingsPatch["pentestModules"]>[PentestModuleId]
>;

function errorMessage(error: unknown): string | null {
  if (typeof error === "string" && error.trim().length > 0) return error;
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return null;
}

function moduleVersionLabel(status: ServerModuleStatus | undefined, isPending: boolean): string {
  if (status?.installedVersion) return status.installedVersion;
  if (isPending) return "Checking…";
  if (status?.state === "unsupported") return "Unsupported";
  return "Not installed";
}

function moduleStatusText(status: ServerModuleStatus | undefined): string | null {
  if (!status) return null;
  if (status.updateCheckError) return status.updateCheckError;
  if (status.updateAvailable && status.latestVersion) {
    return `Version ${status.latestVersion} is available.`;
  }
  if (status.state === "ready" && status.installedVersion) return "Ready to use.";
  if (status.state === "missing") return "Install the managed executable to use this module.";
  if (status.state === "unsupported") return "No managed build is available for this platform.";
  if (status.state === "error") return "Erebus could not resolve this module.";
  return null;
}

function ModulePathField({
  label,
  description,
  value,
  placeholder,
  onSave,
}: {
  label: string;
  description: string;
  value: string;
  placeholder: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  const save = useCallback(() => {
    const nextValue = draft.trim();
    if (nextValue !== value) onSave(nextValue);
  }, [draft, onSave, value]);

  return (
    <label className="grid gap-1.5 sm:grid-cols-[minmax(9rem,0.35fr)_minmax(0,1fr)] sm:items-center sm:gap-4">
      <span className="min-w-0">
        <span className="block text-xs font-medium text-foreground">{label}</span>
        <span className="block text-[11px] leading-4 text-muted-foreground/75">{description}</span>
      </span>
      <Input
        nativeInput
        size="compact"
        value={draft}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

export function ModulesSettings() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const pentestModules = usePrimarySettings((settings) => settings.pentestModules);
  const updateSettings = useUpdatePrimarySettings();
  const [forceUpdateChecks, setForceUpdateChecks] = useState(false);
  const {
    data: modulesResult,
    error: modulesError,
    isPending,
    refresh,
  } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.modulesStatus({
          environmentId,
          input: forceUpdateChecks ? { forceUpdateCheck: true } : {},
        }),
  );
  const updateModule = useAtomCommand(serverEnvironment.updateModule, { reportFailure: false });
  const [updatingModule, setUpdatingModule] = useState<ServerModuleId | null>(null);

  const statuses = useMemo(
    () => new Map(modulesResult?.modules.map((status) => [status.id, status]) ?? []),
    [modulesResult],
  );

  const patchPentestModule = useCallback(
    (id: PentestModuleId, patch: PentestModulePatch) => {
      if (id === "secrethound") {
        updateSettings({ pentestModules: { secrethound: patch } });
      } else if (id === "katana") {
        updateSettings({ pentestModules: { katana: patch } });
      } else {
        updateSettings({ pentestModules: { subfinder: patch } });
      }
    },
    [updateSettings],
  );

  const handleUpdate = useCallback(
    async (id: ServerModuleId) => {
      if (environmentId === null || updatingModule !== null) return;
      setUpdatingModule(id);
      const result = await updateModule({ environmentId, input: { id } });
      setUpdatingModule(null);
      if (result._tag === "Success") {
        refresh();
        toastManager.add({
          type: "success",
          title: result.value.updated
            ? `${MODULE_FALLBACKS[id].displayName} updated`
            : `${MODULE_FALLBACKS[id].displayName} is up to date`,
          description: `Version ${result.value.version}`,
        });
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not update ${MODULE_FALLBACKS[id].displayName}`,
          description: errorMessage(failure) ?? "The module update failed.",
        }),
      );
    },
    [environmentId, refresh, updateModule, updatingModule],
  );

  const handleCheck = useCallback(() => {
    if (forceUpdateChecks) {
      refresh();
    } else {
      setForceUpdateChecks(true);
    }
  }, [forceUpdateChecks, refresh]);

  const queryError = errorMessage(modulesError);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Modules"
        icon={<BoxesIcon className="size-4" />}
        headerAction={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Refresh module status"
            disabled={environmentId === null || isPending || updatingModule !== null}
            onClick={refresh}
          >
            <RefreshCwIcon className={isPending ? "size-3.5 animate-spin" : "size-3.5"} />
          </Button>
        }
      >
        {MODULE_ORDER.map((id) => {
          const status = statuses.get(id);
          const fallback = MODULE_FALLBACKS[id];
          const moduleSettings = id === "argos" ? null : pentestModules[id];
          const usesExternalBinary = Boolean(moduleSettings?.binaryPath.trim());
          const updateDisabled =
            environmentId === null ||
            updatingModule !== null ||
            isPending ||
            status?.state === "unsupported" ||
            usesExternalBinary;
          const updateLabel =
            updatingModule === id
              ? "Updating…"
              : isPending
                ? "Checking…"
                : usesExternalBinary
                  ? "External executable"
                  : status?.updateAvailable && status.latestVersion
                    ? `Update to ${status.latestVersion}`
                    : status?.state === "missing"
                      ? "Install"
                      : "Check for updates";
          const statusText = moduleStatusText(status) ?? queryError;

          return (
            <SettingsRow
              key={id}
              {...searchableSetting(`module-${id}`)}
              title={
                <span className="inline-flex items-baseline gap-2">
                  <span>{status?.displayName ?? fallback.displayName}</span>
                  <code className="text-[11px] font-medium text-muted-foreground">
                    {moduleVersionLabel(status, isPending)}
                  </code>
                </span>
              }
              description={status?.description ?? fallback.description}
              status={statusText}
              control={
                <>
                  {moduleSettings ? (
                    <Switch
                      checked={moduleSettings.enabled}
                      aria-label={`Enable ${fallback.displayName}`}
                      onCheckedChange={(checked) =>
                        patchPentestModule(id as PentestModuleId, {
                          enabled: Boolean(checked),
                        })
                      }
                    />
                  ) : null}
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={updateDisabled}
                    onClick={() => {
                      if (status?.updateAvailable || status?.state === "missing") {
                        void handleUpdate(id);
                      } else {
                        handleCheck();
                      }
                    }}
                  >
                    {updateLabel}
                  </Button>
                </>
              }
            >
              {moduleSettings ? (
                <div className="mt-3 grid gap-3 border-t border-border/40 py-3">
                  <ModulePathField
                    label="Executable"
                    description="Leave empty to use the managed version."
                    value={moduleSettings.binaryPath}
                    placeholder="Managed by Erebus"
                    onSave={(binaryPath) =>
                      patchPentestModule(id as PentestModuleId, { binaryPath })
                    }
                  />
                  {id === "secrethound" ? (
                    <ModulePathField
                      label="Patterns file"
                      description="Optional custom pattern definitions."
                      value={pentestModules.secrethound.patternsPath}
                      placeholder="Default patterns"
                      onSave={(patternsPath) => patchPentestModule("secrethound", { patternsPath })}
                    />
                  ) : null}
                  {id === "katana" ? (
                    <ModulePathField
                      label="Config file"
                      description="Optional Katana configuration file."
                      value={pentestModules.katana.configPath}
                      placeholder="Default configuration"
                      onSave={(configPath) => patchPentestModule("katana", { configPath })}
                    />
                  ) : null}
                  {id === "subfinder" ? (
                    <>
                      <ModulePathField
                        label="Config file"
                        description="Optional Subfinder configuration file."
                        value={pentestModules.subfinder.configPath}
                        placeholder="Default configuration"
                        onSave={(configPath) => patchPentestModule("subfinder", { configPath })}
                      />
                      <ModulePathField
                        label="Provider config"
                        description="Provider source settings and credentials file."
                        value={pentestModules.subfinder.providerConfigPath}
                        placeholder="Default provider configuration"
                        onSave={(providerConfigPath) =>
                          patchPentestModule("subfinder", { providerConfigPath })
                        }
                      />
                    </>
                  ) : null}
                </div>
              ) : null}
            </SettingsRow>
          );
        })}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
