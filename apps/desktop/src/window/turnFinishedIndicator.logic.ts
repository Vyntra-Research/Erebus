export type TurnFinishedOutcome = "success" | "error";

/**
 * Taskbar overlay icons (32x32 PNG, transparent background). Kept inline so the
 * indicator needs no packaged asset: the build only stages the app icon.
 */
export const TURN_FINISHED_OVERLAY_DATA_URLS: Record<TurnFinishedOutcome, string> = {
  success:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABLUlEQVR42u2X2w3DIAxFOwIjREzACEyCGIUNMkJGYAq+M0JGYIRbpUJqagHhETWoqiV/QTgX2zHwePyt0bhTE3dKBp++AWTcKc2dstwpJNyGOexquOFO+QyY+j7XXAEW3Km1Akx9/1b0wH0H/BgNcRe8TURn2JPpqCm4LhgABsAC2ADow5gp+dX8BfAVb9tIKlhOgL5g9xafRvuGzgmwnfCFwPdIMNqscgJ64DOBewAiNjfX21vhuhQefIoJkJGFp7DYa4eF8N3kiWhZKsCQhRcyLiPwkkKWRSlIAJYwJg7RqYEjeXxXhNhG4HNpzVT/hgkRydScuG1qRBkRtb1DN7fiiIhYozk7FVnXYRREbKEOWOXuzfjH8RAXktuvZENcSoe4lg/zMBniafaz9gSkVan3Z6dqJgAAAABJRU5ErkJggg==",
  error:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA70lEQVR42u1X2w3DIAzMCBmBERghHzdAR2CEjJANMgqjMIpHcIWE1Ai1FKeG0KqW7g90h99M099OGgGGgCXB9CCcCXAEeAL4BXw6M2uTbwRQgThHPLtpEFsCgoA4R7xrPyEvvpqZTUSFN2wL8pUftqqKqHF7bjXhkCQcNxDAbxMzlRo1FEDFEk01zA0FRLiSAN9BgC8J4A4CuNTbuwh4OjvSUOklYBlSwLUhuDwJT5ThfuDftcrQCb1wixC632m1YsvMIcGqtGLhMAqHEASVYSQcx1IBQXshkYSgzVYkiLv9vqV0iLV8mI/JEF+zn7U7rgbo+kJE6B4AAAAASUVORK5CYII=",
};

const TURN_FINISHED_PRIORITY: Record<TurnFinishedOutcome, number> = {
  success: 0,
  error: 1,
};

/**
 * Errors stay visible until the user looks at the window: a later successful
 * turn must not downgrade the indicator.
 */
export function mergeTurnFinishedOutcome(
  current: TurnFinishedOutcome | null,
  incoming: TurnFinishedOutcome,
): TurnFinishedOutcome {
  if (current === null) return incoming;
  return TURN_FINISHED_PRIORITY[incoming] > TURN_FINISHED_PRIORITY[current] ? incoming : current;
}

export function turnFinishedDockBadge(outcome: TurnFinishedOutcome): string {
  return outcome === "error" ? "!" : "●";
}

export function turnFinishedOverlayDescription(outcome: TurnFinishedOutcome): string {
  return outcome === "error" ? "Chat turn failed" : "Chat turn finished";
}
