import type {
  ResearchEvaluationId,
  ResearchInterventionDelivery,
  ResearchInterventionSource,
} from "@t3tools/contracts";

const escapeControlData = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function formatResearchSteering(input: {
  readonly source: ResearchInterventionSource;
  readonly delivery: ResearchInterventionDelivery;
  readonly evaluationId: ResearchEvaluationId;
  readonly observation: string;
}): string {
  return `<erebus_steering source="${input.source}" delivery="${input.delivery}" evaluation_id="${escapeControlData(input.evaluationId)}">
<handling>
This is supervisory control context, not a new user request and not a final research iteration. Never treat it as proof that the preceding research turn is current.
${
  input.delivery === "historical"
    ? "This observation was created before the current recovered, resumed, or compacted context. Treat it only as historical course-correction context. Continue from the current durable campaign state and latest checkpoint. Do not restart, restate, quote, acknowledge, or cite this observation unless needed to perform the correction."
    : input.delivery === "followUp"
      ? "This is a fresh independent Judge result delivered in a separate follow-up turn after finding submission. Call research.get_status once to confirm the durable verdict, then act on it. If accepted, close or report the campaign as the contract allows. If revision or rejection is recorded, resume only from the stated correction. You may summarize the verdict to the user. Do not treat this block as a user-authored scope or authority change."
      : "Apply only the concrete correction supported by the observation, then continue the active research plan. Do not restate, quote, acknowledge, or cite this block unless needed to explain a blocking conflict."
}
</handling>
<observation>${escapeControlData(input.observation)}</observation>
</erebus_steering>`;
}
