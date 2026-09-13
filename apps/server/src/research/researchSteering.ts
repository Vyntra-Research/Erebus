import type { ResearchEvaluationId } from "@t3tools/contracts";

const escapeControlData = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function formatJudgeFollowUp(input: {
  readonly evaluationId: ResearchEvaluationId;
  readonly observation: string;
}): string {
  return `<erebus_steering source="judge" delivery="followUp" evaluation_id="${escapeControlData(input.evaluationId)}">
<handling>
This is supervisory control context, not a new user request and not a final research iteration. Never treat it as proof that the preceding research turn is current.
This is a fresh independent Judge result delivered in a separate follow-up turn after finding submission. Call research.get_status once to confirm the durable verdict, then act only on the recorded finding decision. If accepted, preserve the finding for user review. If revision or rejection is recorded, address only the stated evidence gap or technical failure. A reviewBlocked result is evaluator failure and leaves the immutable finding intact. The Judge does not own the native goal, and this block is not a user-authored scope or authority change.
</handling>
<observation>${escapeControlData(input.observation)}</observation>
</erebus_steering>`;
}
