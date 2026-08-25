import {
  addRecentModel,
  type SearchableModelOption,
  SearchableModelPicker,
} from "@renderer/components/searchable-model-picker";
import { claudeCatalogModels, claudeModelAliases } from "@shared/claude-models";

const CLAUDE_DEFAULT_MODEL_VALUE = "claude-default";

const CLAUDE_MODEL_OPTIONS: SearchableModelOption[] = [
  ...claudeModelAliases,
  ...claudeCatalogModels.map((model) => ({
    label: `${model.label} (knowledge cutoff ${model.knowledgeCutoff})`,
    value: model.value,
  })),
];

interface ClaudeModelPickerProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  recentModels?: string[];
  includeDefault?: boolean;
  disabled?: boolean;
}

export function addRecentClaudeModel(
  recentModels: string[],
  model: string | undefined,
): string[] {
  return addRecentModel(recentModels, model, [CLAUDE_DEFAULT_MODEL_VALUE]);
}

export function ClaudeModelPicker({
  id,
  value,
  onChange,
  recentModels = [],
  includeDefault = false,
  disabled,
}: ClaudeModelPickerProps) {
  const options = includeDefault
    ? [
        { label: "Default", value: CLAUDE_DEFAULT_MODEL_VALUE },
        ...CLAUDE_MODEL_OPTIONS,
      ]
    : CLAUDE_MODEL_OPTIONS;

  return (
    <SearchableModelPicker
      id={id}
      value={value}
      models={options}
      recentModels={recentModels}
      excludeFromRecents={[CLAUDE_DEFAULT_MODEL_VALUE]}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

export { CLAUDE_DEFAULT_MODEL_VALUE };
