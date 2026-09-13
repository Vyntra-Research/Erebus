import { PauseIcon, PlayIcon, TargetIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import type { ThreadGoalState } from "../../session-logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

const STATUS_LABELS: Record<ThreadGoalState["status"], string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limited",
  budgetLimited: "Budget limited",
  complete: "Complete",
};

const STATUS_COLORS: Record<ThreadGoalState["status"], string> = {
  active: "bg-amber-400",
  paused: "bg-muted-foreground/70",
  blocked: "bg-destructive",
  usageLimited: "bg-orange-500",
  budgetLimited: "bg-orange-500",
  complete: "bg-emerald-500",
};

function goalProgress(goal: ThreadGoalState): number | null {
  if (goal.status === "complete") return 100;
  if (!goal.tokenBudget || goal.tokenBudget <= 0) return null;
  return Math.min(100, Math.max(1, (goal.tokensUsed / goal.tokenBudget) * 100));
}

export function ThreadGoalBar(props: {
  goal: ThreadGoalState | null;
  busy: boolean;
  onSetStatus: (status: "active" | "paused") => void;
  onClear: () => void;
}) {
  const [clearOpen, setClearOpen] = useState(false);
  if (!props.goal) return null;

  const progress = goalProgress(props.goal);
  const nextStatus = props.goal.status === "active" ? "paused" : "active";
  const usage = props.goal.tokenBudget
    ? `${formatCount(props.goal.tokensUsed)} / ${formatCount(props.goal.tokenBudget)} tokens`
    : `${formatCount(props.goal.tokensUsed)} tokens`;

  return (
    <>
      <Popover>
        <PopoverTrigger
          aria-label={`Goal ${STATUS_LABELS[props.goal.status].toLowerCase()}: ${props.goal.objective}`}
          className="group/goal block w-full px-3 pb-1 pt-0.5 outline-none"
          data-thread-goal
        >
          <span className="relative block h-1 overflow-hidden rounded-full bg-border/70">
            <span
              className={`absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-300 ${STATUS_COLORS[props.goal.status]} ${progress === null && props.goal.status === "active" ? "animate-pulse" : ""}`}
              style={{ width: progress === null ? "100%" : `${progress}%` }}
            />
          </span>
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="start"
          sideOffset={6}
          className="w-96 max-w-[calc(100vw-2rem)]"
        >
          <div className="space-y-3">
            <div className="flex items-start gap-2.5">
              <TargetIcon
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Goal</span>
                  <span>{STATUS_LABELS[props.goal.status]}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatDuration(props.goal.timeUsedSeconds)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{usage}</span>
                </div>
                <p className="mt-1 text-sm leading-5 text-foreground">{props.goal.objective}</p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-1">
              {props.goal.status !== "complete" ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={props.busy}
                  onClick={() => props.onSetStatus(nextStatus)}
                >
                  {nextStatus === "paused" ? (
                    <PauseIcon className="size-3.5" aria-hidden="true" />
                  ) : (
                    <PlayIcon className="size-3.5" aria-hidden="true" />
                  )}
                  {nextStatus === "paused" ? "Pause" : "Resume"}
                </Button>
              ) : null}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Delete goal"
                disabled={props.busy}
                onClick={() => setClearOpen(true)}
              >
                <Trash2Icon className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </PopoverPopup>
      </Popover>

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this goal?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the persistent Codex goal. It does not delete the task or its messages.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={props.busy}
              onClick={() => {
                setClearOpen(false);
                props.onClear();
              }}
            >
              Delete goal
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
