import { useEffect, useRef } from "react";

import { useThreadShells } from "../state/entities";
import { scanFinishedTurns } from "./TurnFinishedNotifier.logic";

/**
 * Renderer-wide bridge between chat turn completion and the desktop shell.
 * Mounted outside the router so every environment and every chat can trigger
 * the taskbar/dock indicator, not just the visible conversation. A no-op in the
 * browser build and in desktop shells that predate the bridge method.
 */
export function TurnFinishedNotifier() {
  const threadShells = useThreadShells();
  const previousRef = useRef<ReturnType<typeof scanFinishedTurns>["next"] | null>(null);

  useEffect(() => {
    const scan = scanFinishedTurns(
      previousRef.current,
      threadShells.map((thread) => ({
        key: `${thread.environmentId}:${thread.id}`,
        latestTurn: thread.latestTurn,
      })),
    );
    previousRef.current = scan.next;
    if (scan.outcome === null) return;

    const pending = window.desktopBridge?.reportTurnFinished?.(scan.outcome);
    if (pending !== undefined) {
      void pending.catch(() => undefined);
    }
  }, [threadShells]);

  return null;
}
