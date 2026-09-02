import {
  ChevronUpIcon,
  ChartNoAxesColumnIcon,
  GitPullRequestIcon,
  SettingsIcon,
} from "lucide-react";
import { memo, useCallback, useMemo } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";

import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { primaryServerProvidersAtom, primaryServerSettingsAtom } from "../../state/server";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { APP_BASE_NAME } from "../../branding";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
    >
      <SidebarTrigger className="relative z-10 md:hidden" />
      <SidebarBrand />
    </SidebarHeader>
  );
});

function SidebarBrand() {
  return (
    <Link
      aria-label="Go to threads"
      className="relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md text-foreground outline-hidden ring-ring focus-visible:ring-2 md:flex"
      to="/"
    >
      <span className="truncate text-sm font-semibold tracking-tight">{APP_BASE_NAME}</span>
    </Link>
  );
}

export const SidebarAccountMenu = memo(function SidebarAccountMenu() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const settings = useAtomValue(primaryServerSettingsAtom);
  const { environments } = useEnvironments();
  const codexAccounts = useMemo(
    () =>
      deriveProviderInstanceEntries(providers)
        .filter((entry) => entry.driverKind === "codex")
        .map((entry) => ({
          ...entry,
          isPrimary: entry.instanceId === settings.codexAccountRouting.primaryInstanceId,
          remainingPercent: entry.snapshot.accountUsage?.remainingPercent ?? null,
        }))
        .toSorted((a, b) => Number(b.isPrimary) - Number(a.isPrimary)),
    [providers, settings.codexAccountRouting.primaryInstanceId],
  );
  const primaryAccount = codexAccounts.find((account) => account.isPrimary) ?? codexAccounts[0];
  // The page reads every connected server, so one of them offering pull requests is enough for
  // the link to lead somewhere.
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/pull-requests", search: { involvement: "all", state: "open" } });
  }, [closeMobileSidebar, navigate]);
  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Popover>
          <PopoverTrigger
            render={
              <SidebarMenuButton className="bg-sidebar-row-hover text-sidebar-foreground">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold">
                  {primaryAccount?.displayName.charAt(0).toUpperCase() ?? "C"}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {primaryAccount?.displayName ?? "Codex accounts"}
                </span>
                {codexAccounts.length > 1 ? (
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {codexAccounts.length}
                  </span>
                ) : null}
                <ChevronUpIcon className="size-3.5 text-muted-foreground" />
              </SidebarMenuButton>
            }
          />
          <PopoverPopup align="start" className="w-72" side="top" sideOffset={6}>
            <div className="space-y-3">
              <div>
                <p className="text-sm font-semibold">Codex accounts</p>
                <p className="text-xs text-muted-foreground">The primary account is used first.</p>
              </div>
              <div className="space-y-3">
                {codexAccounts.map((account) => {
                  const remaining = account.remainingPercent;
                  return (
                    <div className="space-y-1.5" key={account.instanceId}>
                      <div className="flex items-center gap-2 text-xs">
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{
                            backgroundColor: account.accentColor ?? "var(--muted-foreground)",
                          }}
                        />
                        <span className="min-w-0 flex-1 truncate">{account.displayName}</span>
                        {account.isPrimary ? (
                          <span className="text-muted-foreground">Primary</span>
                        ) : null}
                        <span className="tabular-nums text-muted-foreground">
                          {remaining === null ? "—" : `${Math.round(remaining)}%`}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-foreground/75 transition-[width]"
                          style={{ width: `${Math.max(0, Math.min(100, remaining ?? 0))}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
                {codexAccounts.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No Codex account is configured.</p>
                ) : null}
              </div>
              <div className="border-t border-border pt-2">
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                  onClick={handleUsageClick}
                  type="button"
                >
                  <ChartNoAxesColumnIcon className="size-4" /> Usage
                </button>
                {pullRequestsSupported ? (
                  <button
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={handlePullRequestsClick}
                    type="button"
                  >
                    <GitPullRequestIcon className="size-4" /> Pull requests
                  </button>
                ) : null}
              </div>
            </div>
          </PopoverPopup>
        </Popover>
      </SidebarMenuItem>
    </SidebarMenu>
  );
});

const SidebarFooterActions = memo(function SidebarFooterActions() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const openSettings = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/settings/general" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarMenu className="flex-row items-center">
      <SidebarMenuItem className="shrink-0">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Open settings"
                className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-[var(--sidebar-icon-color)] outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2"
                onClick={openSettings}
              >
                <SettingsIcon className="size-4" />
              </button>
            }
          />
          <TooltipPopup side="top">Settings</TooltipPopup>
        </Tooltip>
      </SidebarMenuItem>
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter className="p-[var(--sidebar-content-inset)]">
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarAccountMenu />
      <SidebarFooterActions />
    </SidebarFooter>
  );
});
