import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_RESEARCH_EVALUATOR_MODEL,
  DEFAULT_RESEARCH_EVALUATOR_REASONING_EFFORT,
  type ResearchEvaluatorReasoningEffort,
} from "@t3tools/contracts/settings";
import { ScaleIcon } from "lucide-react";
import { useMemo } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { primaryServerProvidersAtom } from "~/state/server";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const EFFORT_LABELS: Readonly<Record<ResearchEvaluatorReasoningEffort, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

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
      <SettingsSection title="Independent Judge" icon={<ScaleIcon className="size-4" />}>
        <SettingsRow
          {...searchableSetting("research-evaluator-model")}
          description="Codex model used for independent finding reviews. The Judge runs only after a finding is submitted."
          resetAction={
            research.evaluatorModel !== DEFAULT_RESEARCH_EVALUATOR_MODEL ? (
              <SettingResetButton
                label="Judge model"
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
              <SelectTrigger className="w-full sm:w-64" aria-label="Judge model">
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
          description="Reasoning effort used by the independent Judge. Model support is validated by Codex."
          resetAction={
            research.evaluatorReasoningEffort !== DEFAULT_RESEARCH_EVALUATOR_REASONING_EFFORT ? (
              <SettingResetButton
                label="Judge reasoning effort"
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
              <SelectTrigger className="w-full sm:w-40" aria-label="Judge reasoning effort">
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
