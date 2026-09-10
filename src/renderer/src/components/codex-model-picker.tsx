import {
  addRecentModel,
  type SearchableModelOption,
  SearchableModelPicker,
} from "@renderer/components/searchable-model-picker";
import type { CodexModel } from "@shared/codex-models";

const CODEX_DEFAULT_MODEL_VALUE = "codex-default";

interface CodexModelPickerProps {
  id?: string;
  value: string;
  models: CodexModel[];
  onChange: (value: string) => void;
  recentModels?: string[];
  disabled?: boolean;
  triggerClassName?: string;
}

export function addRecentCodexModel(
  recentModels: string[],
  model: string | undefined,
): string[] {
  return addRecentModel(recentModels, model, [CODEX_DEFAULT_MODEL_VALUE]);
}

export function CodexModelPicker({
  id,
  value,
  models,
  onChange,
  recentModels = [],
  disabled,
  triggerClassName,
}: CodexModelPickerProps) {
  const options: SearchableModelOption[] = [
    { label: "Codex default", value: CODEX_DEFAULT_MODEL_VALUE },
    ...models,
  ];

  return (
    <SearchableModelPicker
      id={id}
      value={value}
      models={options}
      recentModels={recentModels}
      excludeFromRecents={[CODEX_DEFAULT_MODEL_VALUE]}
      onChange={onChange}
      disabled={disabled}
      triggerClassName={triggerClassName}
    />
  );
}

export { CODEX_DEFAULT_MODEL_VALUE };
