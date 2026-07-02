import { Button } from "@renderer/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@renderer/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";
import { defaultFilter } from "cmdk";
import { Check, ChevronsUpDown } from "lucide-react";
import { useMemo, useState } from "react";

export interface SearchableModelOption {
  label: string;
  value: string;
}

const MAX_RECENT_MODELS = 8;
const MODEL_FILTER_SCORE_THRESHOLD = 0.2;

const modelCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

interface SearchableModelPickerProps {
  id?: string;
  value: string;
  models: SearchableModelOption[];
  onChange: (value: string) => void;
  recentModels?: string[];
  excludeFromRecents?: string[];
  disabled?: boolean;
}

function uniqueModels(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function sortModels(models: SearchableModelOption[]): SearchableModelOption[] {
  return [...models].sort((a, b) => modelCollator.compare(a.label, b.label));
}

export function addRecentModel(
  recentModels: string[],
  model: string | undefined,
  excludeFromRecents: string[] = [],
): string[] {
  const excluded = new Set(excludeFromRecents);
  const eligibleRecentModels = recentModels.filter(
    (value) => !excluded.has(value),
  );

  if (!model || excluded.has(model)) {
    return eligibleRecentModels;
  }

  return uniqueModels([model, ...eligibleRecentModels]).slice(
    0,
    MAX_RECENT_MODELS,
  );
}

export function SearchableModelPicker({
  id,
  value,
  models,
  onChange,
  recentModels = [],
  excludeFromRecents = [],
  disabled,
}: SearchableModelPickerProps) {
  const [open, setOpen] = useState(false);

  const { allModels, recentModelOptions, selectedModel } = useMemo(() => {
    const modelsByValue = new Map(models.map((model) => [model.value, model]));
    const excluded = new Set(excludeFromRecents);
    const recentValues = uniqueModels([value, ...recentModels]).filter(
      (modelValue) => !excluded.has(modelValue),
    );
    const recentOptions = recentValues
      .map((modelValue) => modelsByValue.get(modelValue))
      .filter((model): model is SearchableModelOption => Boolean(model));
    const recentValueSet = new Set(recentOptions.map((model) => model.value));

    return {
      allModels: sortModels(
        models.filter((model) => !recentValueSet.has(model.value)),
      ),
      recentModelOptions: recentOptions,
      selectedModel: modelsByValue.get(value) ?? {
        label: value,
        value,
      },
    };
  }, [excludeFromRecents, models, recentModels, value]);

  const handleSelect = (nextValue: string) => {
    onChange(nextValue);
    setOpen(false);
  };

  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className="min-w-0 truncate">{selectedModel.label}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[var(--radix-popover-trigger-width)] min-w-[320px] overflow-hidden p-0"
        onWheel={(event) => {
          event.stopPropagation();
        }}
        onTouchMove={(event) => {
          event.stopPropagation();
        }}
      >
        <Command
          shouldFilter
          filter={(value, search, keywords) => {
            const score = defaultFilter(value, search, keywords);
            return score > MODEL_FILTER_SCORE_THRESHOLD ? score : 0;
          }}
          className="max-h-[min(240px,var(--radix-popover-content-available-height,240px))]"
        >
          <CommandInput placeholder="Search models..." />
          <CommandList className="max-h-[min(200px,var(--radix-popover-content-available-height,200px))] min-h-0 overscroll-contain">
            <CommandEmpty>No models found.</CommandEmpty>
            {recentModelOptions.length > 0 ? (
              <CommandGroup heading="Recently used">
                {recentModelOptions.map((model) => (
                  <SearchableModelPickerItem
                    key={model.value}
                    model={model}
                    selected={value === model.value}
                    onSelect={handleSelect}
                  />
                ))}
              </CommandGroup>
            ) : null}
            <CommandGroup heading="All models">
              {allModels.map((model) => (
                <SearchableModelPickerItem
                  key={model.value}
                  model={model}
                  selected={value === model.value}
                  onSelect={handleSelect}
                />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function SearchableModelPickerItem({
  model,
  selected,
  onSelect,
}: {
  model: SearchableModelOption;
  selected: boolean;
  onSelect: (value: string) => void;
}) {
  return (
    <CommandItem
      value={`${model.label}\n${model.value}`}
      onSelect={() => onSelect(model.value)}
      className="justify-between"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm">{model.label}</span>
        <span className="text-muted-foreground block truncate text-xs">
          {model.value}
        </span>
      </span>
      <Check
        className={cn(
          "size-4 shrink-0",
          selected ? "opacity-100" : "opacity-0",
        )}
      />
    </CommandItem>
  );
}
