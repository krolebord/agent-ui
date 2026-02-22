import { Kbd } from "@renderer/components/ui/kbd";
import { Label } from "@renderer/components/ui/label";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@renderer/components/ui/toggle-group";
import type { ClaudePermissionMode } from "@shared/claude-types";
import type { CodexPermissionMode } from "@shared/codex-types";
import {
  formatForDisplay,
  type Hotkey,
  useHotkey,
} from "@tanstack/react-hotkeys";

interface PermissionModeToggleGroupProps {
  label: string;
  permissionMode: ClaudePermissionMode;
  onPermissionModeChange: (value: ClaudePermissionMode) => void;
}

const PERMISSION_MODES: { value: ClaudePermissionMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan" },
  { value: "yolo", label: "Yolo" },
];

function cyclePermissionMode(
  current: ClaudePermissionMode,
): ClaudePermissionMode {
  const index = PERMISSION_MODES.findIndex((mode) => mode.value === current);
  return PERMISSION_MODES[(index + 1) % PERMISSION_MODES.length].value;
}

const cyclePermissionModeHotkey: Hotkey = "Shift+Tab";

export function PermissionModeToggleGroup({
  label,
  permissionMode,
  onPermissionModeChange,
}: PermissionModeToggleGroupProps) {
  useHotkey(
    cyclePermissionModeHotkey,
    () => {
      onPermissionModeChange(cyclePermissionMode(permissionMode));
    },
    {
      ignoreInputs: false,
    },
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Kbd>{formatForDisplay(cyclePermissionModeHotkey)}</Kbd>
        </span>
      </div>
      <ToggleGroup
        type="single"
        variant="outline"
        value={permissionMode}
        onValueChange={(value) => {
          if (value) {
            onPermissionModeChange(value as ClaudePermissionMode);
          }
        }}
        className="w-full"
      >
        {PERMISSION_MODES.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            className="flex-1"
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

// Codex permission modes

interface CodexPermissionModeToggleGroupProps {
  label: string;
  permissionMode: CodexPermissionMode;
  onPermissionModeChange: (value: CodexPermissionMode) => void;
}

const CODEX_PERMISSION_MODES: {
  value: CodexPermissionMode;
  label: string;
}[] = [
  { value: "default", label: "Default" },
  { value: "full-auto", label: "Full Auto" },
  { value: "yolo", label: "Yolo" },
];

function cycleCodexPermissionMode(
  current: CodexPermissionMode,
): CodexPermissionMode {
  const index = CODEX_PERMISSION_MODES.findIndex(
    (mode) => mode.value === current,
  );
  return CODEX_PERMISSION_MODES[(index + 1) % CODEX_PERMISSION_MODES.length]
    .value;
}

export function CodexPermissionModeToggleGroup({
  label,
  permissionMode,
  onPermissionModeChange,
}: CodexPermissionModeToggleGroupProps) {
  useHotkey(
    cyclePermissionModeHotkey,
    () => {
      onPermissionModeChange(cycleCodexPermissionMode(permissionMode));
    },
    {
      ignoreInputs: false,
    },
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Kbd>{formatForDisplay(cyclePermissionModeHotkey)}</Kbd>
        </span>
      </div>
      <ToggleGroup
        type="single"
        variant="outline"
        value={permissionMode}
        onValueChange={(value) => {
          if (value) {
            onPermissionModeChange(value as CodexPermissionMode);
          }
        }}
        className="w-full"
      >
        {CODEX_PERMISSION_MODES.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            className="flex-1"
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
