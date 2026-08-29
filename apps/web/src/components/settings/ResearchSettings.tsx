import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_RESEARCH_EVALUATOR_MODEL,
  DEFAULT_RESEARCH_EVALUATOR_REASONING_EFFORT,
  DEFAULT_RESEARCH_OBSERVER_CONFIDENCE,
  DEFAULT_RESEARCH_OBSERVER_COOLDOWN_MESSAGES,
  DEFAULT_RESEARCH_OBSERVER_INTERVENTIONS_PER_TURN,
  DEFAULT_RESEARCH_OBSERVER_MESSAGE_WINDOW,
  MAX_RESEARCH_OBSERVER_COOLDOWN_MESSAGES,
  MAX_RESEARCH_OBSERVER_INTERVENTIONS_PER_TURN,
  MAX_RESEARCH_OBSERVER_MESSAGE_WINDOW,
  MIN_RESEARCH_OBSERVER_COOLDOWN_MESSAGES,
  MIN_RESEARCH_OBSERVER_INTERVENTIONS_PER_TURN,
  MIN_RESEARCH_OBSERVER_MESSAGE_WINDOW,
  type ResearchEvaluatorReasoningEffort,
} from "@t3tools/contracts/settings";
import { EyeIcon, ScaleIcon } from "lucide-react";
import { useMemo } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { primaryServerProvidersAtom } from "~/state/server";

import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const NO_GROUPING = { useGrouping: false } as const;
const EFFORT_LABELS: Readonly<Record<ResearchEvaluatorReasoningEffort, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

function IntegerControl({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onCommit: (value: number) => void;
}) {
  return (
    <NumberField
      value={value}
      min={min}
      max={max}
      step={1}
      format={NO_GROUPING}
      size="sm"
      className="w-28"
      onValueCommitted={(next) => {
        if (next !== null && Number.isInteger(next) && next >= min && next <= max) onCommit(next);
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Decrease ${label}`} />
        <NumberFieldInput aria-label={label} />
        <NumberFieldIncrement aria-label={`Increase ${label}`} />
      </NumberFieldGroup>
    </NumberField>
  );
}

export function ResearchSettings() {
  const research = usePrimarySettings((settings) => settings.researchSupervision);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const updateSettings = useUpdatePrimarySettings();
  const updateResearch = (patch: Partial<typeof research>) =>
    updateSettings({ researchSupervision: patch });
  const evaluatorModels = useMemo(() => {
    const models = new Map<string, string>();
    for (const provider of providers) {
      if (provider.driver !== "codex") continue;
      for (const model of provider.models) models.set(model.slug, model.name);
    }
    if (!models.has(DEFAULT_RESEARCH_EVALUATOR_MODEL)) {
      models.set(DEFAULT_RESEARCH_EVALUATOR_MODEL, DEFAULT_RESEARCH_EVALUATOR_MODEL);
    }
    if (!models.has(research.evaluatorModel)) {
      models.set(research.evaluatorModel, research.evaluatorModel);
    }
    return [...models].map(([value, label]) => ({ value, label }));
  }, [providers, research.evaluatorModel]);
  const evaluatorModelLabel =
    evaluatorModels.find((model) => model.value === research.evaluatorModel)?.label ??
    research.evaluatorModel;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Observer" icon={<EyeIcon className="size-4" />}>
        <SettingsRow
          {...searchableSetting("research-observer-message-window")}
          description="Evaluate the principal after this many completed assistant messages. Tool calls do not count."
          resetAction={
            research.observerMessageWindow !== DEFAULT_RESEARCH_OBSERVER_MESSAGE_WINDOW ? (
              <SettingResetButton
                label="Observer message window"
                onClick={() =>
                  updateResearch({
                    observerMessageWindow: DEFAULT_RESEARCH_OBSERVER_MESSAGE_WINDOW,
                  })
                }
              />
            ) : null
          }
          control={
            <IntegerControl
              label="Observer message window"
              value={research.observerMessageWindow}
              min={MIN_RESEARCH_OBSERVER_MESSAGE_WINDOW}
              max={MAX_RESEARCH_OBSERVER_MESSAGE_WINDOW}
              onCommit={(observerMessageWindow) => updateResearch({ observerMessageWindow })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("research-observer-confidence")}
          description="Minimum confidence required before a deviation becomes a live course correction."
          resetAction={
            research.observerInterventionConfidence !== DEFAULT_RESEARCH_OBSERVER_CONFIDENCE ? (
              <SettingResetButton
                label="Observer intervention confidence"
                onClick={() =>
                  updateResearch({
                    observerInterventionConfidence: DEFAULT_RESEARCH_OBSERVER_CONFIDENCE,
                  })
                }
              />
            ) : null
          }
          control={
            <NumberField
              value={Math.round(research.observerInterventionConfidence * 100)}
              min={0}
              max={100}
              step={5}
              format={NO_GROUPING}
              size="sm"
              className="w-28"
              onValueCommitted={(next) => {
                if (next !== null && Number.isFinite(next) && next >= 0 && next <= 100) {
                  updateResearch({ observerInterventionConfidence: next / 100 });
                }
              }}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement aria-label="Decrease Observer confidence" />
                <NumberFieldInput aria-label="Observer intervention confidence percent" />
                <NumberFieldIncrement aria-label="Increase Observer confidence" />
              </NumberFieldGroup>
            </NumberField>
          }
        />
        <SettingsRow
          {...searchableSetting("research-observer-cooldown")}
          description="Require this many new principal messages before another Observer correction."
          resetAction={
            research.observerCooldownMessages !== DEFAULT_RESEARCH_OBSERVER_COOLDOWN_MESSAGES ? (
              <SettingResetButton
                label="Observer cooldown"
                onClick={() =>
                  updateResearch({
                    observerCooldownMessages: DEFAULT_RESEARCH_OBSERVER_COOLDOWN_MESSAGES,
                  })
                }
              />
            ) : null
          }
          control={
            <IntegerControl
              label="Observer cooldown messages"
              value={research.observerCooldownMessages}
              min={MIN_RESEARCH_OBSERVER_COOLDOWN_MESSAGES}
              max={MAX_RESEARCH_OBSERVER_COOLDOWN_MESSAGES}
              onCommit={(observerCooldownMessages) => updateResearch({ observerCooldownMessages })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("research-observer-turn-limit")}
          description="Maximum live course corrections the Observer may send during one active principal response. A new user turn resets the limit."
          resetAction={
            research.observerMaxInterventionsPerTurn !==
            DEFAULT_RESEARCH_OBSERVER_INTERVENTIONS_PER_TURN ? (
              <SettingResetButton
                label="Observer turn limit"
                onClick={() =>
                  updateResearch({
                    observerMaxInterventionsPerTurn:
                      DEFAULT_RESEARCH_OBSERVER_INTERVENTIONS_PER_TURN,
                  })
                }
              />
            ) : null
          }
          control={
            <IntegerControl
              label="Maximum corrections per active run"
              value={research.observerMaxInterventionsPerTurn}
              min={MIN_RESEARCH_OBSERVER_INTERVENTIONS_PER_TURN}
              max={MAX_RESEARCH_OBSERVER_INTERVENTIONS_PER_TURN}
              onCommit={(observerMaxInterventionsPerTurn) =>
                updateResearch({ observerMaxInterventionsPerTurn })
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Observer and Judge runtime" icon={<ScaleIcon className="size-4" />}>
        <SettingsRow
          {...searchableSetting("research-evaluator-model")}
          description="Codex model used for independent Observer and Judge evaluations."
          resetAction={
            research.evaluatorModel !== DEFAULT_RESEARCH_EVALUATOR_MODEL ? (
              <SettingResetButton
                label="research evaluator model"
                onClick={() => updateResearch({ evaluatorModel: DEFAULT_RESEARCH_EVALUATOR_MODEL })}
              />
            ) : null
          }
          control={
            <Select
              value={research.evaluatorModel}
              onValueChange={(evaluatorModel) => {
                if (evaluatorModel) updateResearch({ evaluatorModel });
              }}
            >
              <SelectTrigger className="w-full sm:w-64" aria-label="Observer and Judge model">
                <SelectValue>{evaluatorModelLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {evaluatorModels.map((model) => (
                  <SelectItem hideIndicator key={model.value} value={model.value}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{model.label}</span>
                      {model.label !== model.value ? (
                        <code className="truncate text-[10px] text-muted-foreground">
                          {model.value}
                        </code>
                      ) : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("research-evaluator-effort")}
          description="Reasoning effort used by both independent evaluators. Model support is validated by Codex."
          resetAction={
            research.evaluatorReasoningEffort !== DEFAULT_RESEARCH_EVALUATOR_REASONING_EFFORT ? (
              <SettingResetButton
                label="research evaluator effort"
                onClick={() =>
                  updateResearch({
                    evaluatorReasoningEffort: DEFAULT_RESEARCH_EVALUATOR_REASONING_EFFORT,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={research.evaluatorReasoningEffort}
              onValueChange={(value) =>
                updateResearch({
                  evaluatorReasoningEffort: value as ResearchEvaluatorReasoningEffort,
                })
              }
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Research evaluator effort">
                <SelectValue>{EFFORT_LABELS[research.evaluatorReasoningEffort]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {Object.entries(EFFORT_LABELS).map(([value, label]) => (
                  <SelectItem hideIndicator key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
