import { Maximize2Icon, PauseIcon, PlayIcon, TargetIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

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
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;

  const remainderSeconds = seconds % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${remainderSeconds}s`;
}

const STATUS_TITLES: Record<ThreadGoalState["status"], string> = {
  active: "Goal in progress",
  paused: "Goal paused",
  blocked: "Goal blocked",
  usageLimited: "Goal waiting for usage",
  budgetLimited: "Goal budget reached",
  complete: "Goal complete",
};

const STATUS_COLORS: Record<ThreadGoalState["status"], string> = {
  active: "text-amber-500",
  paused: "text-muted-foreground",
  blocked: "text-destructive",
  usageLimited: "text-orange-500",
  budgetLimited: "text-orange-500",
  complete: "text-emerald-500",
};

function toMilliseconds(timestamp: number): number {
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

function elapsedSeconds(goal: ThreadGoalState, nowMs: number): number {
  if (goal.status !== "active") return goal.timeUsedSeconds;
  return goal.timeUsedSeconds + Math.max(0, (nowMs - toMilliseconds(goal.updatedAt)) / 1000);
}

export function ThreadGoalBar(props: {
  goal: ThreadGoalState | null;
  busy: boolean;
  onSetStatus: (status: "active" | "paused") => void;
  onClear: () => void;
}) {
  const [clearOpen, setClearOpen] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now);

  useEffect(() => {
    if (props.goal?.status !== "active") return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [props.goal?.status]);

  if (!props.goal) return null;

  const nextStatus = props.goal.status === "active" ? "paused" : "active";
  const duration = formatDuration(elapsedSeconds(props.goal, nowMs));
  const usage = props.goal.tokenBudget
    ? `${formatCount(props.goal.tokensUsed)} / ${formatCount(props.goal.tokenBudget)} tokens`
    : `${formatCount(props.goal.tokensUsed)} tokens`;

  return (
    <>
      <div
        className="relative z-[1] mx-3 -mb-2.5 flex h-11 min-w-0 items-start gap-2 rounded-t-2xl border border-border/80 bg-card px-3 pb-3 pt-2 text-xs shadow-sm"
        data-thread-goal
      >
        <TargetIcon
          className={`mt-0.5 size-3.5 shrink-0 ${STATUS_COLORS[props.goal.status]}`}
          aria-hidden="true"
        />
        <span className="shrink-0 font-medium text-foreground">
          {STATUS_TITLES[props.goal.status]}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {props.goal.objective}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{duration}</span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          className="-my-1 size-6 shrink-0 rounded-full"
          aria-label="Delete goal"
          disabled={props.busy}
          onClick={() => setClearOpen(true)}
        >
          <Trash2Icon className="size-3.5" aria-hidden="true" />
        </Button>
        {props.goal.status !== "complete" ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            className="-my-1 size-6 shrink-0 rounded-full"
            aria-label={nextStatus === "paused" ? "Pause goal" : "Resume goal"}
            disabled={props.busy}
            onClick={() => props.onSetStatus(nextStatus)}
          >
            {nextStatus === "paused" ? (
              <PauseIcon className="size-3.5" aria-hidden="true" />
            ) : (
              <PlayIcon className="size-3.5" aria-hidden="true" />
            )}
          </Button>
        ) : null}
        <Popover>
          <PopoverTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                className="-my-1 size-6 shrink-0 rounded-full"
                aria-label="Show goal details"
              >
                <Maximize2Icon className="size-3.5" aria-hidden="true" />
              </Button>
            }
          />
          <PopoverPopup
            side="top"
            align="end"
            sideOffset={8}
            className="w-96 max-w-[calc(100vw-2rem)]"
          >
            <div className="flex items-start gap-2.5">
              <TargetIcon
                className={`mt-0.5 size-4 shrink-0 ${STATUS_COLORS[props.goal.status]}`}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {STATUS_TITLES[props.goal.status]}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{duration}</span>
                  <span aria-hidden="true">·</span>
                  <span>{usage}</span>
                </div>
                <p className="mt-1 text-sm leading-5 text-foreground">{props.goal.objective}</p>
              </div>
            </div>
          </PopoverPopup>
        </Popover>
      </div>

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
