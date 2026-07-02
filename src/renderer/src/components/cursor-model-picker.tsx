import {
  addRecentModel,
  SearchableModelPicker,
} from "@renderer/components/searchable-model-picker";
import { cursorModels } from "@shared/cursor-models";

const AUTO_MODEL_VALUE = "auto";

interface CursorModelPickerProps {
  value: string;
  onChange: (value: string) => void;
  recentModels?: string[];
  includeAuto?: boolean;
  disabled?: boolean;
}

export function addRecentCursorModel(
  recentModels: string[],
  model: string | undefined,
): string[] {
  return addRecentModel(recentModels, model, [AUTO_MODEL_VALUE]);
}

export function CursorModelPicker({
  value,
  onChange,
  recentModels = [],
  includeAuto = false,
  disabled,
}: CursorModelPickerProps) {
  return (
    <SearchableModelPicker
      value={value}
      models={cursorModels.filter(
        (model) => includeAuto || model.value !== AUTO_MODEL_VALUE,
      )}
      recentModels={recentModels}
      excludeFromRecents={[AUTO_MODEL_VALUE]}
      onChange={onChange}
      disabled={disabled}
    />
  );
}
