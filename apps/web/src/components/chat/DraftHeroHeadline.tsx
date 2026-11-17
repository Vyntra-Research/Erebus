import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { FolderPlusIcon, MessagesSquareIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useClientSettings } from "~/hooks/useSettings";
import { selectProjectGroupingSettings } from "~/logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface DraftHeroHeadlineProps {
  readonly activeEnvironmentId: EnvironmentId;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

const STANDALONE_PROJECT_VALUE = "__standalone__";

export function DraftHeroHeadline({
  activeEnvironmentId,
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const handleNewThread = useNewThreadHandler();
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        buildSidebarProjectSnapshots({
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        projectSortOrder,
      ),
    [
      environmentLabelById,
      primaryEnvironmentId,
      projectGroupingSettings,
      projectSortOrder,
      projects,
      threads,
    ],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: activeProjectRef,
      }),
    [activeProjectRef, projectGroups],
  );
  const projectEntryByKey = useMemo(
    () => new Map(projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const)),
    [projectPickerEntries],
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey =
    activeProjectGroup?.projectKey ??
    (activeProjectRef ? scopedProjectKey(activeProjectRef) : STANDALONE_PROJECT_VALUE);
  const activeProjectDisplayName = activeProjectGroup?.displayName ?? activeProjectTitle;
  const canChooseProject = projectPickerEntries.length > 0;

  const projectSelector = canChooseProject ? (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              aria-label="Choose a project"
              className="pointer-events-auto inline-block max-w-64 truncate border-foreground/60 border-b border-dotted align-baseline text-foreground transition-colors hover:border-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          {activeProjectDisplayName ?? "No project"}
        </TooltipTrigger>
        {activeProjectDisplayName ? (
          <TooltipPopup side="top" className="max-w-80">
            {activeProjectDisplayName}
          </TooltipPopup>
        ) : null}
      </Tooltip>
      <MenuPopup align="center" className="max-h-80 min-w-40! w-max max-w-64 overflow-y-auto">
        <MenuRadioGroup
          value={activeProjectKey}
          onValueChange={(value) => {
            if (value === STANDALONE_PROJECT_VALUE) {
              if (activeProjectKey === STANDALONE_PROJECT_VALUE) {
                return;
              }
              void handleNewThread(
                { environmentId: activeEnvironmentId, projectId: null },
                { replace: true, carryComposerContent: true },
              );
              return;
            }
            const entry = projectEntryByKey.get(value as string);
            if (!entry || value === activeProjectKey) {
              return;
            }
            const project = entry.targetProject;
            // Changing the repo of a draft moves the typed content along:
            // the user started writing in the wrong project, not a new task.
            void handleNewThread(scopeProjectRef(project.environmentId, project.id), {
              replace: true,
              carryComposerContent: true,
            });
          }}
        >
          <MenuRadioItem value={STANDALONE_PROJECT_VALUE} closeOnClick>
            <MessagesSquareIcon />
            No project
          </MenuRadioItem>
          <MenuSeparator />
          {projectPickerEntries.map(({ group }) => {
            return (
              <MenuRadioItem key={group.projectKey} value={group.projectKey} closeOnClick>
                <Tooltip>
                  <TooltipTrigger render={<span className="block min-w-0 truncate" />}>
                    {group.displayName}
                  </TooltipTrigger>
                  <TooltipPopup side="top" className="max-w-80">
                    {group.displayName}
                  </TooltipPopup>
                </Tooltip>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={openAddProject}>
          <FolderPlusIcon />
          New project
        </MenuItem>
      </MenuPopup>
    </Menu>
  ) : (
    <button
      type="button"
      onClick={openAddProject}
      className="pointer-events-auto inline cursor-pointer border-muted-foreground/35 border-b border-dotted text-muted-foreground/60 transition-colors hover:border-muted-foreground/60 hover:text-muted-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      Add a project
    </button>
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-2 text-center">
      <h1 className="font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        What can I help with?
      </h1>
      <div className="text-sm text-muted-foreground">Project: {projectSelector}</div>
    </div>
  );
}
