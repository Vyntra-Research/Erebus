import { useAtomValue } from "@effect/atom-react";
import { ProviderInstanceId, type SelectProviderOptionDescriptor } from "@t3tools/contracts";
import {
  DEFAULT_RESEARCH_EVALUATOR_INSTANCE_ID,
  DEFAULT_RESEARCH_EVALUATOR_MODEL,
  DEFAULT_RESEARCH_EVALUATOR_REASONING_EFFORT,
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

const MODEL_KEY_SEPARATOR = "\u001f";

function modelKey(instanceId: string, model: string): string {
  return `${instanceId}${MODEL_KEY_SEPARATOR}${model}`;
}

function splitModelKey(value: string): { instanceId: ProviderInstanceId; model: string } | null {
  const separator = value.indexOf(MODEL_KEY_SEPARATOR);
  if (separator < 1 || separator === value.length - 1) return null;
  return {
    instanceId: ProviderInstanceId.make(value.slice(0, separator)),
    model: value.slice(separator + 1),
  };
}

interface EvaluatorModelOption {
  readonly key: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly label: string;
  readonly providerLabel: string;
  readonly option: SelectProviderOptionDescriptor | undefined;
}

export function ResearchSettings() {
  const research = usePrimarySettings((settings) => settings.researchSupervision);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const updateSettings = useUpdatePrimarySettings();
  const updateResearch = (patch: Partial<typeof research>) =>
    updateSettings({ researchSupervision: patch });
  const evaluatorModels = useMemo(() => {
    const models: EvaluatorModelOption[] = [];
    for (const provider of providers) {
      if (
        (provider.driver !== "codex" && provider.driver !== "opencode") ||
        !provider.enabled ||
        !provider.installed ||
        provider.availability === "unavailable"
      ) {
        continue;
      }
      for (const model of provider.models) {
        const option = model.capabilities?.optionDescriptors?.find(
          (candidate): candidate is SelectProviderOptionDescriptor =>
            candidate.type === "select" &&
            (candidate.id === "reasoningEffort" || candidate.id === "variant"),
        );
        models.push({
          key: modelKey(provider.instanceId, model.slug),
          instanceId: provider.instanceId,
          model: model.slug,
          label: model.name,
          providerLabel:
            provider.displayName ?? (provider.driver === "opencode" ? "OpenCode" : "Codex"),
          option,
        });
      }
    }
    const selectedKey = modelKey(research.evaluatorInstanceId, research.evaluatorModel);
    if (!models.some((model) => model.key === selectedKey)) {
      models.push({
        key: selectedKey,
        instanceId: research.evaluatorInstanceId,
        model: research.evaluatorModel,
        label: research.evaluatorModel,
        providerLabel: research.evaluatorInstanceId,
        option: undefined,
      });
    }
    return models;
  }, [providers, research.evaluatorInstanceId, research.evaluatorModel]);
  const selectedModelKey = modelKey(research.evaluatorInstanceId, research.evaluatorModel);
  const selectedModel = evaluatorModels.find((model) => model.key === selectedModelKey);
  const evaluatorModelLabel = selectedModel?.label ?? research.evaluatorModel;
  const effortOptions = selectedModel?.option?.options ?? [];
  const effortLabel =
    effortOptions.find((option) => option.id === research.evaluatorReasoningEffort)?.label ??
    research.evaluatorReasoningEffort;
  const defaultEffort =
    selectedModel?.option?.currentValue ??
    effortOptions.find((option) => option.isDefault)?.id ??
    effortOptions[0]?.id ??
    DEFAULT_RESEARCH_EVALUATOR_REASONING_EFFORT;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Independent Judge" icon={<ScaleIcon className="size-4" />}>
        <SettingsRow
          {...searchableSetting("research-evaluator-model")}
          description="Model used for independent finding reviews. The Judge runs only after a finding is submitted."
          resetAction={
            research.evaluatorInstanceId !== DEFAULT_RESEARCH_EVALUATOR_INSTANCE_ID ||
            research.evaluatorModel !== DEFAULT_RESEARCH_EVALUATOR_MODEL ? (
              <SettingResetButton
                label="Judge model"
                onClick={() =>
                  updateResearch({
                    evaluatorInstanceId: DEFAULT_RESEARCH_EVALUATOR_INSTANCE_ID,
                    evaluatorModel: DEFAULT_RESEARCH_EVALUATOR_MODEL,
                    evaluatorOptionId: "reasoningEffort",
                    evaluatorReasoningEffort: DEFAULT_RESEARCH_EVALUATOR_REASONING_EFFORT,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={selectedModelKey}
              onValueChange={(value) => {
                if (!value) return;
                const selection = splitModelKey(value);
                const model = evaluatorModels.find((candidate) => candidate.key === value);
                if (!selection || !model) return;
                const optionId =
                  model.option?.id === "variant"
                    ? "variant"
                    : model.option?.id === "reasoningEffort"
                      ? "reasoningEffort"
                      : "default";
                const optionValue =
                  model.option?.currentValue ??
                  model.option?.options.find((option) => option.isDefault)?.id ??
                  model.option?.options[0]?.id ??
                  (optionId === "reasoningEffort"
                    ? DEFAULT_RESEARCH_EVALUATOR_REASONING_EFFORT
                    : "default");
                updateResearch({
                  evaluatorInstanceId: selection.instanceId,
                  evaluatorModel: selection.model,
                  evaluatorOptionId: optionId,
                  evaluatorReasoningEffort: optionValue,
                });
              }}
            >
              <SelectTrigger className="w-full sm:w-64" aria-label="Judge model">
                <SelectValue>{evaluatorModelLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {evaluatorModels.map((model) => (
                  <SelectItem hideIndicator key={model.key} value={model.key}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{model.label}</span>
                      <code className="truncate text-[10px] text-muted-foreground">
                        {model.providerLabel} · {model.model}
                      </code>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("research-evaluator-effort")}
          description="Reasoning mode supported by the selected model and provider."
          resetAction={
            research.evaluatorReasoningEffort !== defaultEffort ? (
              <SettingResetButton
                label="Judge reasoning effort"
                onClick={() =>
                  updateResearch({
                    evaluatorReasoningEffort: defaultEffort,
                  })
                }
              />
            ) : null
          }
          control={
            effortOptions.length > 0 ? (
              <Select
                value={research.evaluatorReasoningEffort}
                onValueChange={(value) => {
                  if (value) updateResearch({ evaluatorReasoningEffort: value });
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="Judge reasoning effort">
                  <SelectValue>{effortLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {effortOptions.map((option) => (
                    <SelectItem hideIndicator key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : (
              <span className="text-xs text-muted-foreground">Provider default</span>
            )
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
