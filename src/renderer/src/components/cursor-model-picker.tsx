import { addRecentModel } from "@renderer/components/searchable-model-picker";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Input } from "@renderer/components/ui/input";
import { cn } from "@renderer/lib/utils";
import type { CursorModelVariant } from "@shared/cursor-model-types";
import { cursorModelFamilies } from "@shared/cursor-models";
import { Check, ChevronsUpDown } from "lucide-react";
import { useMemo, useRef, useState } from "react";

const AUTO_MODEL_VALUE = "auto";

interface CursorModelPickerProps {
  value: string;
  onChange: (value: string) => void;
  recentModels?: string[];
  includeAuto?: boolean;
  disabled?: boolean;
  triggerClassName?: string;
}

export function addRecentCursorModel(
  recentModels: string[],
  model: string | undefined,
): string[] {
  return addRecentModel(recentModels, model, [AUTO_MODEL_VALUE]);
}

export function filterCursorModels(
  models: CursorModelVariant[],
  search: string,
): CursorModelVariant[] {
  const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return models.filter((model) => {
    const text = `${model.displayLabel} ${model.value}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function CursorModelPicker({
  value,
  onChange,
  recentModels = [],
  includeAuto = false,
  disabled,
  triggerClassName,
}: CursorModelPickerProps) {
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const families = useMemo(
    () =>
      cursorModelFamilies.filter(
        (family) => includeAuto || family.id !== AUTO_MODEL_VALUE,
      ),
    [includeAuto],
  );
  const modelsByValue = new Map(
    families.flatMap((family) =>
      family.variants.map((variant) => [variant.value, variant] as const),
    ),
  );
  const recentOptions = addRecentCursorModel(
    recentModels.filter((model) => modelsByValue.has(model)),
    modelsByValue.has(value) ? value : undefined,
  ).flatMap((model) => {
    const option = modelsByValue.get(model);
    return option ? [option] : [];
  });

  const isSearching = search.trim().length > 0;
  const searchResults = filterCursorModels([...modelsByValue.values()], search);

  return (
    <DropdownMenu onOpenChange={() => setSearch("")}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn("w-full justify-between font-normal", triggerClassName)}
        >
          <span className="min-w-0 truncate">
            {modelsByValue.get(value)?.displayLabel ?? value}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={contentRef}
        onPointerMoveCapture={(event) => {
          if (document.activeElement === searchRef.current)
            event.preventDefault();
        }}
        onKeyDown={(event) => {
          const firstItem =
            contentRef.current?.querySelector('[role="menuitem"]');
          if (event.key === "ArrowUp" && event.target === firstItem) {
            event.preventDefault();
            searchRef.current?.focus();
          }
        }}
        align="start"
        sideOffset={6}
        className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[280px] max-h-[min(400px,var(--radix-dropdown-menu-content-available-height))] overscroll-contain"
        onWheel={(event) => event.stopPropagation()}
        onTouchMove={(event) => event.stopPropagation()}
      >
        <div className="bg-popover sticky -top-1 z-10 -mx-1 -mt-1 border-b p-2">
          <Input
            ref={searchRef}
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search models..."
            aria-label="Search Cursor models"
            onKeyDown={(event) => {
              if (event.key === "Escape" || event.key === "Tab") return;
              event.stopPropagation();
              if (event.nativeEvent.isComposing) return;
              const items =
                contentRef.current?.querySelectorAll<HTMLElement>(
                  '[role="menuitem"]',
                );
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const item =
                  event.key === "ArrowDown"
                    ? items?.[0]
                    : items?.[items.length - 1];
                item?.focus();
              } else if (event.key === "Enter" && isSearching) {
                event.preventDefault();
                items?.[0]?.click();
              }
            }}
          />
        </div>
        {isSearching ? (
          searchResults.length > 0 ? (
            searchResults.map((model) => (
              <CursorModelItem
                key={model.value}
                model={model}
                selectedValue={value}
                onChange={onChange}
              />
            ))
          ) : (
            <div
              role="status"
              className="text-muted-foreground px-2 py-6 text-center text-sm"
            >
              No models found.
            </div>
          )
        ) : (
          <>
            {recentOptions.length > 0 && (
              <>
                <DropdownMenuLabel>Recently used</DropdownMenuLabel>
                {recentOptions.map((model) => (
                  <CursorModelItem
                    key={model.value}
                    model={model}
                    selectedValue={value}
                    onChange={onChange}
                  />
                ))}
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuLabel>All models</DropdownMenuLabel>
            {families.map((family) => {
              const [only] = family.variants;
              if (family.variants.length === 1 && only) {
                return (
                  <CursorModelItem
                    key={family.id}
                    model={only}
                    selectedValue={value}
                    onChange={onChange}
                  />
                );
              }
              return (
                <DropdownMenuSub key={family.id}>
                  <DropdownMenuSubTrigger textValue={family.label}>
                    <span className="min-w-0 flex-1 truncate">
                      {family.label}
                    </span>
                    {family.variants.some((model) => model.value === value) && (
                      <Check className="size-4" />
                    )}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent
                      className="max-h-[min(400px,var(--radix-dropdown-menu-content-available-height))] min-w-[200px] overflow-y-auto overscroll-contain"
                      onWheel={(event) => event.stopPropagation()}
                      onTouchMove={(event) => event.stopPropagation()}
                    >
                      {family.variants.map((model) => (
                        <CursorModelItem
                          key={model.value}
                          model={model}
                          selectedValue={value}
                          onChange={onChange}
                          variant
                        />
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>
              );
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CursorModelItem({
  model,
  selectedValue,
  onChange,
  variant = false,
}: {
  model: CursorModelVariant;
  selectedValue: string;
  onChange: (value: string) => void;
  variant?: boolean;
}) {
  const label = variant ? model.variantLabel : model.displayLabel;
  return (
    <DropdownMenuItem
      textValue={label}
      onSelect={() => onChange(model.value)}
      className="justify-between"
    >
      <span className="min-w-0 truncate">{label}</span>
      <Check
        className={cn(
          "size-4 shrink-0",
          selectedValue === model.value ? "opacity-100" : "opacity-0",
        )}
      />
    </DropdownMenuItem>
  );
}
