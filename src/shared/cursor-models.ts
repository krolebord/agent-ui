import type { CursorModelFamily } from "./cursor-model-types";

export const cursorModelFamilies: CursorModelFamily[] = [
  {
    id: "auto",
    label: "Auto",
    variants: [
      {
        value: "auto",
        variantLabel: "Default",
        displayLabel: "Auto",
      },
    ],
  },
  {
    id: "grok-4.7",
    label: "Grok 4.7",
    variants: [
      {
        value: "grok-4.7-xhigh",
        variantLabel: "Extra high",
        displayLabel: "Grok 4.7 · Extra high",
      },
      {
        value: "grok-4.7-xhigh-fast",
        variantLabel: "Extra high · Fast",
        displayLabel: "Grok 4.7 · Extra high · Fast",
      },
      {
        value: "grok-4.7-high",
        variantLabel: "High",
        displayLabel: "Grok 4.7 · High",
      },
      {
        value: "grok-4.7-high-fast",
        variantLabel: "High · Fast",
        displayLabel: "Grok 4.7 · High · Fast",
      },
      {
        value: "grok-4.7-medium",
        variantLabel: "Medium",
        displayLabel: "Grok 4.7 · Medium",
      },
      {
        value: "grok-4.7-medium-fast",
        variantLabel: "Medium · Fast",
        displayLabel: "Grok 4.7 · Medium · Fast",
      },
      {
        value: "grok-4.7-low",
        variantLabel: "Low",
        displayLabel: "Grok 4.7 · Low",
      },
      {
        value: "grok-4.7-low-fast",
        variantLabel: "Low · Fast",
        displayLabel: "Grok 4.7 · Low · Fast",
      },
    ],
  },
  {
    id: "cursor-grok-4.6",
    label: "Cursor Grok 4.6",
    variants: [
      {
        value: "cursor-grok-4.6-xhigh",
        variantLabel: "Extra high",
        displayLabel: "Cursor Grok 4.6 · Extra high",
      },
      {
        value: "cursor-grok-4.6-xhigh-fast",
        variantLabel: "Extra high · Fast",
        displayLabel: "Cursor Grok 4.6 · Extra high · Fast",
      },
      {
        value: "cursor-grok-4.6-high",
        variantLabel: "High",
        displayLabel: "Cursor Grok 4.6 · High",
      },
      {
        value: "cursor-grok-4.6-high-fast",
        variantLabel: "High · Fast",
        displayLabel: "Cursor Grok 4.6 · High · Fast",
      },
      {
        value: "cursor-grok-4.6-medium",
        variantLabel: "Medium",
        displayLabel: "Cursor Grok 4.6 · Medium",
      },
      {
        value: "cursor-grok-4.6-medium-fast",
        variantLabel: "Medium · Fast",
        displayLabel: "Cursor Grok 4.6 · Medium · Fast",
      },
      {
        value: "cursor-grok-4.6-low",
        variantLabel: "Low",
        displayLabel: "Cursor Grok 4.6 · Low",
      },
      {
        value: "cursor-grok-4.6-low-fast",
        variantLabel: "Low · Fast",
        displayLabel: "Cursor Grok 4.6 · Low · Fast",
      },
    ],
  },
  {
    id: "cursor-grok-4.5",
    label: "Cursor Grok 4.5",
    variants: [
      {
        value: "cursor-grok-4.5-high",
        variantLabel: "High",
        displayLabel: "Cursor Grok 4.5 · High",
      },
      {
        value: "cursor-grok-4.5-high-fast",
        variantLabel: "High · Fast",
        displayLabel: "Cursor Grok 4.5 · High · Fast",
      },
      {
        value: "cursor-grok-4.5-medium",
        variantLabel: "Medium",
        displayLabel: "Cursor Grok 4.5 · Medium",
      },
      {
        value: "cursor-grok-4.5-medium-fast",
        variantLabel: "Medium · Fast",
        displayLabel: "Cursor Grok 4.5 · Medium · Fast",
      },
      {
        value: "cursor-grok-4.5-low",
        variantLabel: "Low",
        displayLabel: "Cursor Grok 4.5 · Low",
      },
      {
        value: "cursor-grok-4.5-low-fast",
        variantLabel: "Low · Fast",
        displayLabel: "Cursor Grok 4.5 · Low · Fast",
      },
    ],
  },
  {
    id: "composer-2.5",
    label: "Composer 2.5",
    variants: [
      {
        value: "composer-2.5",
        variantLabel: "Default",
        displayLabel: "Composer 2.5",
      },
      {
        value: "composer-2.5-fast",
        variantLabel: "Fast",
        displayLabel: "Composer 2.5 · Fast",
      },
    ],
  },
  {
    id: "muse-spark-1.3",
    label: "Muse Spark 1.3",
    variants: [
      {
        value: "muse-spark-1.3-max",
        variantLabel: "Max",
        displayLabel: "Muse Spark 1.3 · Max",
      },
      {
        value: "muse-spark-1.3-xhigh",
        variantLabel: "Extra high",
        displayLabel: "Muse Spark 1.3 · Extra high",
      },
      {
        value: "muse-spark-1.3-high",
        variantLabel: "High",
        displayLabel: "Muse Spark 1.3 · High",
      },
      {
        value: "muse-spark-1.3-medium",
        variantLabel: "Medium",
        displayLabel: "Muse Spark 1.3 · Medium",
      },
      {
        value: "muse-spark-1.3-low",
        variantLabel: "Low",
        displayLabel: "Muse Spark 1.3 · Low",
      },
      {
        value: "muse-spark-1.3-minimal",
        variantLabel: "Minimal",
        displayLabel: "Muse Spark 1.3 · Minimal",
      },
    ],
  },
  {
    id: "kimi-k3",
    label: "Kimi K3",
    variants: [
      {
        value: "kimi-k3-max",
        variantLabel: "Max",
        displayLabel: "Kimi K3 · Max",
      },
      {
        value: "kimi-k3-high",
        variantLabel: "High",
        displayLabel: "Kimi K3 · High",
      },
      {
        value: "kimi-k3-low",
        variantLabel: "Low",
        displayLabel: "Kimi K3 · Low",
      },
    ],
  },
  {
    id: "kimi-k2.7-code",
    label: "Kimi K2.7 Code",
    variants: [
      {
        value: "kimi-k2.7-code",
        variantLabel: "Default",
        displayLabel: "Kimi K2.7 Code",
      },
    ],
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT 5.6 Terra",
    variants: [
      {
        value: "gpt-5.6-terra-max",
        variantLabel: "Max",
        displayLabel: "GPT 5.6 Terra · Max",
      },
      {
        value: "gpt-5.6-terra-max-fast",
        variantLabel: "Max · Fast",
        displayLabel: "GPT 5.6 Terra · Max · Fast",
      },
      {
        value: "gpt-5.6-terra-xhigh",
        variantLabel: "Extra high",
        displayLabel: "GPT 5.6 Terra · Extra high",
      },
      {
        value: "gpt-5.6-terra-xhigh-fast",
        variantLabel: "Extra high · Fast",
        displayLabel: "GPT 5.6 Terra · Extra high · Fast",
      },
      {
        value: "gpt-5.6-terra-high",
        variantLabel: "High",
        displayLabel: "GPT 5.6 Terra · High",
      },
      {
        value: "gpt-5.6-terra-high-fast",
        variantLabel: "High · Fast",
        displayLabel: "GPT 5.6 Terra · High · Fast",
      },
      {
        value: "gpt-5.6-terra-medium",
        variantLabel: "Medium",
        displayLabel: "GPT 5.6 Terra · Medium",
      },
      {
        value: "gpt-5.6-terra-medium-fast",
        variantLabel: "Medium · Fast",
        displayLabel: "GPT 5.6 Terra · Medium · Fast",
      },
      {
        value: "gpt-5.6-terra-low",
        variantLabel: "Low",
        displayLabel: "GPT 5.6 Terra · Low",
      },
      {
        value: "gpt-5.6-terra-low-fast",
        variantLabel: "Low · Fast",
        displayLabel: "GPT 5.6 Terra · Low · Fast",
      },
      {
        value: "gpt-5.6-terra-none",
        variantLabel: "None",
        displayLabel: "GPT 5.6 Terra · None",
      },
      {
        value: "gpt-5.6-terra-none-fast",
        variantLabel: "None · Fast",
        displayLabel: "GPT 5.6 Terra · None · Fast",
      },
    ],
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT 5.6 Sol",
    variants: [
      {
        value: "gpt-5.6-sol-max",
        variantLabel: "Max",
        displayLabel: "GPT 5.6 Sol · Max",
      },
      {
        value: "gpt-5.6-sol-max-fast",
        variantLabel: "Max · Fast",
        displayLabel: "GPT 5.6 Sol · Max · Fast",
      },
      {
        value: "gpt-5.6-sol-xhigh",
        variantLabel: "Extra high",
        displayLabel: "GPT 5.6 Sol · Extra high",
      },
      {
        value: "gpt-5.6-sol-xhigh-fast",
        variantLabel: "Extra high · Fast",
        displayLabel: "GPT 5.6 Sol · Extra high · Fast",
      },
      {
        value: "gpt-5.6-sol-high",
        variantLabel: "High",
        displayLabel: "GPT 5.6 Sol · High",
      },
      {
        value: "gpt-5.6-sol-high-fast",
        variantLabel: "High · Fast",
        displayLabel: "GPT 5.6 Sol · High · Fast",
      },
      {
        value: "gpt-5.6-sol-medium",
        variantLabel: "Medium",
        displayLabel: "GPT 5.6 Sol · Medium",
      },
      {
        value: "gpt-5.6-sol-medium-fast",
        variantLabel: "Medium · Fast",
        displayLabel: "GPT 5.6 Sol · Medium · Fast",
      },
      {
        value: "gpt-5.6-sol-low",
        variantLabel: "Low",
        displayLabel: "GPT 5.6 Sol · Low",
      },
      {
        value: "gpt-5.6-sol-low-fast",
        variantLabel: "Low · Fast",
        displayLabel: "GPT 5.6 Sol · Low · Fast",
      },
      {
        value: "gpt-5.6-sol-none",
        variantLabel: "None",
        displayLabel: "GPT 5.6 Sol · None",
      },
      {
        value: "gpt-5.6-sol-none-fast",
        variantLabel: "None · Fast",
        displayLabel: "GPT 5.6 Sol · None · Fast",
      },
    ],
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT 5.6 Luna",
    variants: [
      {
        value: "gpt-5.6-luna-max",
        variantLabel: "Max",
        displayLabel: "GPT 5.6 Luna · Max",
      },
      {
        value: "gpt-5.6-luna-max-fast",
        variantLabel: "Max · Fast",
        displayLabel: "GPT 5.6 Luna · Max · Fast",
      },
      {
        value: "gpt-5.6-luna-xhigh",
        variantLabel: "Extra high",
        displayLabel: "GPT 5.6 Luna · Extra high",
      },
      {
        value: "gpt-5.6-luna-xhigh-fast",
        variantLabel: "Extra high · Fast",
        displayLabel: "GPT 5.6 Luna · Extra high · Fast",
      },
      {
        value: "gpt-5.6-luna-high",
        variantLabel: "High",
        displayLabel: "GPT 5.6 Luna · High",
      },
      {
        value: "gpt-5.6-luna-high-fast",
        variantLabel: "High · Fast",
        displayLabel: "GPT 5.6 Luna · High · Fast",
      },
      {
        value: "gpt-5.6-luna-medium",
        variantLabel: "Medium",
        displayLabel: "GPT 5.6 Luna · Medium",
      },
      {
        value: "gpt-5.6-luna-medium-fast",
        variantLabel: "Medium · Fast",
        displayLabel: "GPT 5.6 Luna · Medium · Fast",
      },
      {
        value: "gpt-5.6-luna-low",
        variantLabel: "Low",
        displayLabel: "GPT 5.6 Luna · Low",
      },
      {
        value: "gpt-5.6-luna-low-fast",
        variantLabel: "Low · Fast",
        displayLabel: "GPT 5.6 Luna · Low · Fast",
      },
      {
        value: "gpt-5.6-luna-none",
        variantLabel: "None",
        displayLabel: "GPT 5.6 Luna · None",
      },
      {
        value: "gpt-5.6-luna-none-fast",
        variantLabel: "None · Fast",
        displayLabel: "GPT 5.6 Luna · None · Fast",
      },
    ],
  },
  {
    id: "gpt-5.5",
    label: "GPT 5.5",
    variants: [
      {
        value: "gpt-5.5-extra-high",
        variantLabel: "Extra high",
        displayLabel: "GPT 5.5 · Extra high",
      },
      {
        value: "gpt-5.5-extra-high-fast",
        variantLabel: "Extra high · Fast",
        displayLabel: "GPT 5.5 · Extra high · Fast",
      },
      {
        value: "gpt-5.5-high",
        variantLabel: "High",
        displayLabel: "GPT 5.5 · High",
      },
      {
        value: "gpt-5.5-high-fast",
        variantLabel: "High · Fast",
        displayLabel: "GPT 5.5 · High · Fast",
      },
      {
        value: "gpt-5.5-medium",
        variantLabel: "Medium",
        displayLabel: "GPT 5.5 · Medium",
      },
      {
        value: "gpt-5.5-medium-fast",
        variantLabel: "Medium · Fast",
        displayLabel: "GPT 5.5 · Medium · Fast",
      },
      {
        value: "gpt-5.5-low",
        variantLabel: "Low",
        displayLabel: "GPT 5.5 · Low",
      },
      {
        value: "gpt-5.5-low-fast",
        variantLabel: "Low · Fast",
        displayLabel: "GPT 5.5 · Low · Fast",
      },
      {
        value: "gpt-5.5-none",
        variantLabel: "None",
        displayLabel: "GPT 5.5 · None",
      },
      {
        value: "gpt-5.5-none-fast",
        variantLabel: "None · Fast",
        displayLabel: "GPT 5.5 · None · Fast",
      },
    ],
  },
  {
    id: "gpt-5.4",
    label: "GPT 5.4",
    variants: [
      {
        value: "gpt-5.4-xhigh",
        variantLabel: "Extra high",
        displayLabel: "GPT 5.4 · Extra high",
      },
      {
        value: "gpt-5.4-xhigh-fast",
        variantLabel: "Extra high · Fast",
        displayLabel: "GPT 5.4 · Extra high · Fast",
      },
      {
        value: "gpt-5.4-high",
        variantLabel: "High",
        displayLabel: "GPT 5.4 · High",
      },
      {
        value: "gpt-5.4-high-fast",
        variantLabel: "High · Fast",
        displayLabel: "GPT 5.4 · High · Fast",
      },
      {
        value: "gpt-5.4-medium",
        variantLabel: "Medium",
        displayLabel: "GPT 5.4 · Medium",
      },
      {
        value: "gpt-5.4-medium-fast",
        variantLabel: "Medium · Fast",
        displayLabel: "GPT 5.4 · Medium · Fast",
      },
      {
        value: "gpt-5.4-low",
        variantLabel: "Low",
        displayLabel: "GPT 5.4 · Low",
      },
    ],
  },
  {
    id: "gpt-5.4-nano",
    label: "GPT 5.4 Nano",
    variants: [
      {
        value: "gpt-5.4-nano-xhigh",
        variantLabel: "Extra high",
        displayLabel: "GPT 5.4 Nano · Extra high",
      },
      {
        value: "gpt-5.4-nano-high",
        variantLabel: "High",
        displayLabel: "GPT 5.4 Nano · High",
      },
      {
        value: "gpt-5.4-nano-medium",
        variantLabel: "Medium",
        displayLabel: "GPT 5.4 Nano · Medium",
      },
      {
        value: "gpt-5.4-nano-low",
        variantLabel: "Low",
        displayLabel: "GPT 5.4 Nano · Low",
      },
      {
        value: "gpt-5.4-nano-none",
        variantLabel: "None",
        displayLabel: "GPT 5.4 Nano · None",
      },
    ],
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT 5.4 Mini",
    variants: [
      {
        value: "gpt-5.4-mini-xhigh",
        variantLabel: "Extra high",
        displayLabel: "GPT 5.4 Mini · Extra high",
      },
      {
        value: "gpt-5.4-mini-high",
        variantLabel: "High",
        displayLabel: "GPT 5.4 Mini · High",
      },
      {
        value: "gpt-5.4-mini-medium",
        variantLabel: "Medium",
        displayLabel: "GPT 5.4 Mini · Medium",
      },
      {
        value: "gpt-5.4-mini-low",
        variantLabel: "Low",
        displayLabel: "GPT 5.4 Mini · Low",
      },
      {
        value: "gpt-5.4-mini-none",
        variantLabel: "None",
        displayLabel: "GPT 5.4 Mini · None",
      },
    ],
  },
  {
    id: "gpt-5.3-codex",
    label: "GPT 5.3 Codex",
    variants: [
      {
        value: "gpt-5.3-codex",
        variantLabel: "Default",
        displayLabel: "GPT 5.3 Codex",
      },
      {
        value: "gpt-5.3-codex-fast",
        variantLabel: "Fast",
        displayLabel: "GPT 5.3 Codex · Fast",
      },
      {
        value: "gpt-5.3-codex-xhigh",
        variantLabel: "Extra high",
        displayLabel: "GPT 5.3 Codex · Extra high",
      },
      {
        value: "gpt-5.3-codex-xhigh-fast",
        variantLabel: "Extra high · Fast",
        displayLabel: "GPT 5.3 Codex · Extra high · Fast",
      },
      {
        value: "gpt-5.3-codex-high",
        variantLabel: "High",
        displayLabel: "GPT 5.3 Codex · High",
      },
      {
        value: "gpt-5.3-codex-high-fast",
        variantLabel: "High · Fast",
        displayLabel: "GPT 5.3 Codex · High · Fast",
      },
      {
        value: "gpt-5.3-codex-low",
        variantLabel: "Low",
        displayLabel: "GPT 5.3 Codex · Low",
      },
      {
        value: "gpt-5.3-codex-low-fast",
        variantLabel: "Low · Fast",
        displayLabel: "GPT 5.3 Codex · Low · Fast",
      },
    ],
  },
  {
    id: "gpt-5.2",
    label: "GPT 5.2",
    variants: [
      {
        value: "gpt-5.2",
        variantLabel: "Default",
        displayLabel: "GPT 5.2",
      },
      {
        value: "gpt-5.2-fast",
        variantLabel: "Fast",
        displayLabel: "GPT 5.2 · Fast",
      },
      {
        value: "gpt-5.2-xhigh",
        variantLabel: "Extra high",
        displayLabel: "GPT 5.2 · Extra high",
      },
      {
        value: "gpt-5.2-xhigh-fast",
        variantLabel: "Extra high · Fast",
        displayLabel: "GPT 5.2 · Extra high · Fast",
      },
      {
        value: "gpt-5.2-high",
        variantLabel: "High",
        displayLabel: "GPT 5.2 · High",
      },
      {
        value: "gpt-5.2-high-fast",
        variantLabel: "High · Fast",
        displayLabel: "GPT 5.2 · High · Fast",
      },
      {
        value: "gpt-5.2-low",
        variantLabel: "Low",
        displayLabel: "GPT 5.2 · Low",
      },
      {
        value: "gpt-5.2-low-fast",
        variantLabel: "Low · Fast",
        displayLabel: "GPT 5.2 · Low · Fast",
      },
    ],
  },
  {
    id: "gpt-5.1",
    label: "GPT 5.1",
    variants: [
      {
        value: "gpt-5.1",
        variantLabel: "Default",
        displayLabel: "GPT 5.1",
      },
      {
        value: "gpt-5.1-high",
        variantLabel: "High",
        displayLabel: "GPT 5.1 · High",
      },
      {
        value: "gpt-5.1-low",
        variantLabel: "Low",
        displayLabel: "GPT 5.1 · Low",
      },
    ],
  },
  {
    id: "gpt-5-mini",
    label: "GPT 5 Mini",
    variants: [
      {
        value: "gpt-5-mini",
        variantLabel: "Default",
        displayLabel: "GPT 5 Mini",
      },
    ],
  },
  {
    id: "glm-5.2",
    label: "GLM 5.2",
    variants: [
      {
        value: "glm-5.2-max",
        variantLabel: "Max",
        displayLabel: "GLM 5.2 · Max",
      },
      {
        value: "glm-5.2-high",
        variantLabel: "High",
        displayLabel: "GLM 5.2 · High",
      },
    ],
  },
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    variants: [
      {
        value: "gemini-3.8-flash-high",
        variantLabel: "High",
        displayLabel: "Gemini 3.8 Flash · High",
      },
      {
        value: "gemini-3.8-flash-medium",
        variantLabel: "Medium",
        displayLabel: "Gemini 3.8 Flash · Medium",
      },
      {
        value: "gemini-3.8-flash-low",
        variantLabel: "Low",
        displayLabel: "Gemini 3.8 Flash · Low",
      },
    ],
  },
  {
    id: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    variants: [
      {
        value: "gemini-3.7-flash-high",
        variantLabel: "High",
        displayLabel: "Gemini 3.7 Flash · High",
      },
      {
        value: "gemini-3.7-flash-medium",
        variantLabel: "Medium",
        displayLabel: "Gemini 3.7 Flash · Medium",
      },
      {
        value: "gemini-3.7-flash-low",
        variantLabel: "Low",
        displayLabel: "Gemini 3.7 Flash · Low",
      },
    ],
  },
  {
    id: "gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    variants: [
      {
        value: "gemini-3.6-flash-high",
        variantLabel: "High",
        displayLabel: "Gemini 3.6 Flash · High",
      },
      {
        value: "gemini-3.6-flash-medium",
        variantLabel: "Medium",
        displayLabel: "Gemini 3.6 Flash · Medium",
      },
      {
        value: "gemini-3.6-flash-low",
        variantLabel: "Low",
        displayLabel: "Gemini 3.6 Flash · Low",
      },
      {
        value: "gemini-3.6-flash-minimal",
        variantLabel: "Minimal",
        displayLabel: "Gemini 3.6 Flash · Minimal",
      },
    ],
  },
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    variants: [
      {
        value: "gemini-3.5-flash",
        variantLabel: "Default",
        displayLabel: "Gemini 3.5 Flash",
      },
    ],
  },
  {
    id: "gemini-3.1-pro",
    label: "Gemini 3.1 Pro",
    variants: [
      {
        value: "gemini-3.1-pro",
        variantLabel: "Default",
        displayLabel: "Gemini 3.1 Pro",
      },
    ],
  },
  {
    id: "gemini-3-flash",
    label: "Gemini 3 Flash",
    variants: [
      {
        value: "gemini-3-flash",
        variantLabel: "Default",
        displayLabel: "Gemini 3 Flash",
      },
    ],
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    variants: [
      {
        value: "claude-sonnet-5-max",
        variantLabel: "Max",
        displayLabel: "Claude Sonnet 5 · Max",
      },
      {
        value: "claude-sonnet-5-xhigh",
        variantLabel: "Extra high",
        displayLabel: "Claude Sonnet 5 · Extra high",
      },
      {
        value: "claude-sonnet-5-high",
        variantLabel: "High",
        displayLabel: "Claude Sonnet 5 · High",
      },
      {
        value: "claude-sonnet-5-medium",
        variantLabel: "Medium",
        displayLabel: "Claude Sonnet 5 · Medium",
      },
      {
        value: "claude-sonnet-5-low",
        variantLabel: "Low",
        displayLabel: "Claude Sonnet 5 · Low",
      },
      {
        value: "claude-sonnet-5-thinking-max",
        variantLabel: "Thinking · Max",
        displayLabel: "Claude Sonnet 5 · Thinking · Max",
      },
      {
        value: "claude-sonnet-5-thinking-xhigh",
        variantLabel: "Thinking · Extra high",
        displayLabel: "Claude Sonnet 5 · Thinking · Extra high",
      },
      {
        value: "claude-sonnet-5-thinking-high",
        variantLabel: "Thinking · High",
        displayLabel: "Claude Sonnet 5 · Thinking · High",
      },
      {
        value: "claude-sonnet-5-thinking-medium",
        variantLabel: "Thinking · Medium",
        displayLabel: "Claude Sonnet 5 · Thinking · Medium",
      },
      {
        value: "claude-sonnet-5-thinking-low",
        variantLabel: "Thinking · Low",
        displayLabel: "Claude Sonnet 5 · Thinking · Low",
      },
    ],
  },
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    variants: [
      {
        value: "claude-opus-5-high",
        variantLabel: "High",
        displayLabel: "Claude Opus 5 · High",
      },
      {
        value: "claude-opus-5-high-fast",
        variantLabel: "High · Fast",
        displayLabel: "Claude Opus 5 · High · Fast",
      },
      {
        value: "claude-opus-5-medium",
        variantLabel: "Medium",
        displayLabel: "Claude Opus 5 · Medium",
      },
      {
        value: "claude-opus-5-medium-fast",
        variantLabel: "Medium · Fast",
        displayLabel: "Claude Opus 5 · Medium · Fast",
      },
      {
        value: "claude-opus-5-low",
        variantLabel: "Low",
        displayLabel: "Claude Opus 5 · Low",
      },
      {
        value: "claude-opus-5-low-fast",
        variantLabel: "Low · Fast",
        displayLabel: "Claude Opus 5 · Low · Fast",
      },
      {
        value: "claude-opus-5-thinking-max",
        variantLabel: "Thinking · Max",
        displayLabel: "Claude Opus 5 · Thinking · Max",
      },
      {
        value: "claude-opus-5-thinking-max-fast",
        variantLabel: "Thinking · Max · Fast",
        displayLabel: "Claude Opus 5 · Thinking · Max · Fast",
      },
      {
        value: "claude-opus-5-thinking-xhigh",
        variantLabel: "Thinking · Extra high",
        displayLabel: "Claude Opus 5 · Thinking · Extra high",
      },
      {
        value: "claude-opus-5-thinking-xhigh-fast",
        variantLabel: "Thinking · Extra high · Fast",
        displayLabel: "Claude Opus 5 · Thinking · Extra high · Fast",
      },
      {
        value: "claude-opus-5-thinking-high",
        variantLabel: "Thinking · High",
        displayLabel: "Claude Opus 5 · Thinking · High",
      },
      {
        value: "claude-opus-5-thinking-high-fast",
        variantLabel: "Thinking · High · Fast",
        displayLabel: "Claude Opus 5 · Thinking · High · Fast",
      },
      {
        value: "claude-opus-5-thinking-medium",
        variantLabel: "Thinking · Medium",
        displayLabel: "Claude Opus 5 · Thinking · Medium",
      },
      {
        value: "claude-opus-5-thinking-medium-fast",
        variantLabel: "Thinking · Medium · Fast",
        displayLabel: "Claude Opus 5 · Thinking · Medium · Fast",
      },
      {
        value: "claude-opus-5-thinking-low",
        variantLabel: "Thinking · Low",
        displayLabel: "Claude Opus 5 · Thinking · Low",
      },
      {
        value: "claude-opus-5-thinking-low-fast",
        variantLabel: "Thinking · Low · Fast",
        displayLabel: "Claude Opus 5 · Thinking · Low · Fast",
      },
    ],
  },
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    variants: [
      {
        value: "claude-opus-5-5-max",
        variantLabel: "Max",
        displayLabel: "Claude Opus 5.5 · Max",
      },
      {
        value: "claude-opus-5-5-max-fast",
        variantLabel: "Max · Fast",
        displayLabel: "Claude Opus 5.5 · Max · Fast",
      },
      {
        value: "claude-opus-5-5-xhigh",
        variantLabel: "Extra high",
        displayLabel: "Claude Opus 5.5 · Extra high",
      },
      {
        value: "claude-opus-5-5-xhigh-fast",
        variantLabel: "Extra high · Fast",
        displayLabel: "Claude Opus 5.5 · Extra high · Fast",
      },
      {
        value: "claude-opus-5-5-high",
        variantLabel: "High",
        displayLabel: "Claude Opus 5.5 · High",
      },
      {
        value: "claude-opus-5-5-high-fast",
        variantLabel: "High · Fast",
        displayLabel: "Claude Opus 5.5 · High · Fast",
      },
      {
        value: "claude-opus-5-5-medium",
        variantLabel: "Medium",
        displayLabel: "Claude Opus 5.5 · Medium",
      },
      {
        value: "claude-opus-5-5-medium-fast",
        variantLabel: "Medium · Fast",
        displayLabel: "Claude Opus 5.5 · Medium · Fast",
      },
      {
        value: "claude-opus-5-5-low",
        variantLabel: "Low",
        displayLabel: "Claude Opus 5.5 · Low",
      },
      {
        value: "claude-opus-5-5-low-fast",
        variantLabel: "Low · Fast",
        displayLabel: "Claude Opus 5.5 · Low · Fast",
      },
    ],
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    variants: [
      {
        value: "claude-opus-4-8-max",
        variantLabel: "Max",
        displayLabel: "Claude Opus 4.8 · Max",
      },
      {
        value: "claude-opus-4-8-max-fast",
        variantLabel: "Max · Fast",
        displayLabel: "Claude Opus 4.8 · Max · Fast",
      },
      {
        value: "claude-opus-4-8-xhigh",
        variantLabel: "Extra high",
        displayLabel: "Claude Opus 4.8 · Extra high",
      },
      {
        value: "claude-opus-4-8-xhigh-fast",
        variantLabel: "Extra high · Fast",
        displayLabel: "Claude Opus 4.8 · Extra high · Fast",
      },
      {
        value: "claude-opus-4-8-high",
        variantLabel: "High",
        displayLabel: "Claude Opus 4.8 · High",
      },
      {
        value: "claude-opus-4-8-high-fast",
        variantLabel: "High · Fast",
        displayLabel: "Claude Opus 4.8 · High · Fast",
      },
      {
        value: "claude-opus-4-8-medium",
        variantLabel: "Medium",
        displayLabel: "Claude Opus 4.8 · Medium",
      },
      {
        value: "claude-opus-4-8-medium-fast",
        variantLabel: "Medium · Fast",
        displayLabel: "Claude Opus 4.8 · Medium · Fast",
      },
      {
        value: "claude-opus-4-8-low",
        variantLabel: "Low",
        displayLabel: "Claude Opus 4.8 · Low",
      },
      {
        value: "claude-opus-4-8-low-fast",
        variantLabel: "Low · Fast",
        displayLabel: "Claude Opus 4.8 · Low · Fast",
      },
      {
        value: "claude-opus-4-8-thinking-max",
        variantLabel: "Thinking · Max",
        displayLabel: "Claude Opus 4.8 · Thinking · Max",
      },
      {
        value: "claude-opus-4-8-thinking-max-fast",
        variantLabel: "Thinking · Max · Fast",
        displayLabel: "Claude Opus 4.8 · Thinking · Max · Fast",
      },
      {
        value: "claude-opus-4-8-thinking-xhigh",
        variantLabel: "Thinking · Extra high",
        displayLabel: "Claude Opus 4.8 · Thinking · Extra high",
      },
      {
        value: "claude-opus-4-8-thinking-xhigh-fast",
        variantLabel: "Thinking · Extra high · Fast",
        displayLabel: "Claude Opus 4.8 · Thinking · Extra high · Fast",
      },
      {
        value: "claude-opus-4-8-thinking-high",
        variantLabel: "Thinking · High",
        displayLabel: "Claude Opus 4.8 · Thinking · High",
      },
      {
        value: "claude-opus-4-8-thinking-high-fast",
        variantLabel: "Thinking · High · Fast",
        displayLabel: "Claude Opus 4.8 · Thinking · High · Fast",
      },
      {
        value: "claude-opus-4-8-thinking-medium",
        variantLabel: "Thinking · Medium",
        displayLabel: "Claude Opus 4.8 · Thinking · Medium",
      },
      {
        value: "claude-opus-4-8-thinking-medium-fast",
        variantLabel: "Thinking · Medium · Fast",
        displayLabel: "Claude Opus 4.8 · Thinking · Medium · Fast",
      },
      {
        value: "claude-opus-4-8-thinking-low",
        variantLabel: "Thinking · Low",
        displayLabel: "Claude Opus 4.8 · Thinking · Low",
      },
      {
        value: "claude-opus-4-8-thinking-low-fast",
        variantLabel: "Thinking · Low · Fast",
        displayLabel: "Claude Opus 4.8 · Thinking · Low · Fast",
      },
    ],
  },
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    variants: [
      {
        value: "claude-opus-4-7-max",
        variantLabel: "Max",
        displayLabel: "Claude Opus 4.7 · Max",
      },
      {
        value: "claude-opus-4-7-max-fast",
        variantLabel: "Max · Fast",
        displayLabel: "Claude Opus 4.7 · Max · Fast",
      },
      {
        value: "claude-opus-4-7-xhigh",
        variantLabel: "Extra high",
        displayLabel: "Claude Opus 4.7 · Extra high",
      },
      {
        value: "claude-opus-4-7-xhigh-fast",
        variantLabel: "Extra high · Fast",
        displayLabel: "Claude Opus 4.7 · Extra high · Fast",
      },
      {
        value: "claude-opus-4-7-high",
        variantLabel: "High",
        displayLabel: "Claude Opus 4.7 · High",
      },
      {
        value: "claude-opus-4-7-high-fast",
        variantLabel: "High · Fast",
        displayLabel: "Claude Opus 4.7 · High · Fast",
      },
      {
        value: "claude-opus-4-7-medium",
        variantLabel: "Medium",
        displayLabel: "Claude Opus 4.7 · Medium",
      },
      {
        value: "claude-opus-4-7-medium-fast",
        variantLabel: "Medium · Fast",
        displayLabel: "Claude Opus 4.7 · Medium · Fast",
      },
      {
        value: "claude-opus-4-7-low",
        variantLabel: "Low",
        displayLabel: "Claude Opus 4.7 · Low",
      },
      {
        value: "claude-opus-4-7-low-fast",
        variantLabel: "Low · Fast",
        displayLabel: "Claude Opus 4.7 · Low · Fast",
      },
      {
        value: "claude-opus-4-7-thinking-max",
        variantLabel: "Thinking · Max",
        displayLabel: "Claude Opus 4.7 · Thinking · Max",
      },
      {
        value: "claude-opus-4-7-thinking-max-fast",
        variantLabel: "Thinking · Max · Fast",
        displayLabel: "Claude Opus 4.7 · Thinking · Max · Fast",
      },
      {
        value: "claude-opus-4-7-thinking-xhigh",
        variantLabel: "Thinking · Extra high",
        displayLabel: "Claude Opus 4.7 · Thinking · Extra high",
      },
      {
        value: "claude-opus-4-7-thinking-xhigh-fast",
        variantLabel: "Thinking · Extra high · Fast",
        displayLabel: "Claude Opus 4.7 · Thinking · Extra high · Fast",
      },
      {
        value: "claude-opus-4-7-thinking-high",
        variantLabel: "Thinking · High",
        displayLabel: "Claude Opus 4.7 · Thinking · High",
      },
      {
        value: "claude-opus-4-7-thinking-high-fast",
        variantLabel: "Thinking · High · Fast",
        displayLabel: "Claude Opus 4.7 · Thinking · High · Fast",
      },
      {
        value: "claude-opus-4-7-thinking-medium",
        variantLabel: "Thinking · Medium",
        displayLabel: "Claude Opus 4.7 · Thinking · Medium",
      },
      {
        value: "claude-opus-4-7-thinking-medium-fast",
        variantLabel: "Thinking · Medium · Fast",
        displayLabel: "Claude Opus 4.7 · Thinking · Medium · Fast",
      },
      {
        value: "claude-opus-4-7-thinking-low",
        variantLabel: "Thinking · Low",
        displayLabel: "Claude Opus 4.7 · Thinking · Low",
      },
      {
        value: "claude-opus-4-7-thinking-low-fast",
        variantLabel: "Thinking · Low · Fast",
        displayLabel: "Claude Opus 4.7 · Thinking · Low · Fast",
      },
    ],
  },
  {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    variants: [
      {
        value: "claude-fable-5-max",
        variantLabel: "Max",
        displayLabel: "Claude Fable 5 · Max",
      },
      {
        value: "claude-fable-5-xhigh",
        variantLabel: "Extra high",
        displayLabel: "Claude Fable 5 · Extra high",
      },
      {
        value: "claude-fable-5-high",
        variantLabel: "High",
        displayLabel: "Claude Fable 5 · High",
      },
      {
        value: "claude-fable-5-medium",
        variantLabel: "Medium",
        displayLabel: "Claude Fable 5 · Medium",
      },
      {
        value: "claude-fable-5-low",
        variantLabel: "Low",
        displayLabel: "Claude Fable 5 · Low",
      },
      {
        value: "claude-fable-5-thinking-max",
        variantLabel: "Thinking · Max",
        displayLabel: "Claude Fable 5 · Thinking · Max",
      },
      {
        value: "claude-fable-5-thinking-xhigh",
        variantLabel: "Thinking · Extra high",
        displayLabel: "Claude Fable 5 · Thinking · Extra high",
      },
      {
        value: "claude-fable-5-thinking-high",
        variantLabel: "Thinking · High",
        displayLabel: "Claude Fable 5 · Thinking · High",
      },
      {
        value: "claude-fable-5-thinking-medium",
        variantLabel: "Thinking · Medium",
        displayLabel: "Claude Fable 5 · Thinking · Medium",
      },
      {
        value: "claude-fable-5-thinking-low",
        variantLabel: "Thinking · Low",
        displayLabel: "Claude Fable 5 · Thinking · Low",
      },
    ],
  },
  {
    id: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    variants: [
      {
        value: "claude-fable-5-1-max",
        variantLabel: "Max",
        displayLabel: "Claude Fable 5.1 · Max",
      },
      {
        value: "claude-fable-5-1-xhigh",
        variantLabel: "Extra high",
        displayLabel: "Claude Fable 5.1 · Extra high",
      },
      {
        value: "claude-fable-5-1-high",
        variantLabel: "High",
        displayLabel: "Claude Fable 5.1 · High",
      },
      {
        value: "claude-fable-5-1-medium",
        variantLabel: "Medium",
        displayLabel: "Claude Fable 5.1 · Medium",
      },
      {
        value: "claude-fable-5-1-low",
        variantLabel: "Low",
        displayLabel: "Claude Fable 5.1 · Low",
      },
      {
        value: "claude-fable-5-1-thinking-max",
        variantLabel: "Thinking · Max",
        displayLabel: "Claude Fable 5.1 · Thinking · Max",
      },
      {
        value: "claude-fable-5-1-thinking-xhigh",
        variantLabel: "Thinking · Extra high",
        displayLabel: "Claude Fable 5.1 · Thinking · Extra high",
      },
      {
        value: "claude-fable-5-1-thinking-high",
        variantLabel: "Thinking · High",
        displayLabel: "Claude Fable 5.1 · Thinking · High",
      },
      {
        value: "claude-fable-5-1-thinking-medium",
        variantLabel: "Thinking · Medium",
        displayLabel: "Claude Fable 5.1 · Thinking · Medium",
      },
      {
        value: "claude-fable-5-1-thinking-low",
        variantLabel: "Thinking · Low",
        displayLabel: "Claude Fable 5.1 · Thinking · Low",
      },
    ],
  },
  {
    id: "claude-4.6-sonnet",
    label: "Claude 4.6 Sonnet",
    variants: [
      {
        value: "claude-4.6-sonnet-medium",
        variantLabel: "Medium",
        displayLabel: "Claude 4.6 Sonnet · Medium",
      },
      {
        value: "claude-4.6-sonnet-medium-thinking",
        variantLabel: "Medium · Thinking",
        displayLabel: "Claude 4.6 Sonnet · Medium · Thinking",
      },
    ],
  },
  {
    id: "claude-4.6-opus",
    label: "Claude 4.6 Opus",
    variants: [
      {
        value: "claude-4.6-opus-max",
        variantLabel: "Max",
        displayLabel: "Claude 4.6 Opus · Max",
      },
      {
        value: "claude-4.6-opus-high",
        variantLabel: "High",
        displayLabel: "Claude 4.6 Opus · High",
      },
      {
        value: "claude-4.6-opus-max-thinking",
        variantLabel: "Max · Thinking",
        displayLabel: "Claude 4.6 Opus · Max · Thinking",
      },
      {
        value: "claude-4.6-opus-high-thinking",
        variantLabel: "High · Thinking",
        displayLabel: "Claude 4.6 Opus · High · Thinking",
      },
    ],
  },
  {
    id: "claude-4.5-sonnet",
    label: "Claude 4.5 Sonnet",
    variants: [
      {
        value: "claude-4.5-sonnet",
        variantLabel: "Default",
        displayLabel: "Claude 4.5 Sonnet",
      },
      {
        value: "claude-4.5-sonnet-thinking",
        variantLabel: "Thinking",
        displayLabel: "Claude 4.5 Sonnet · Thinking",
      },
    ],
  },
  {
    id: "claude-4.5-opus",
    label: "Claude 4.5 Opus",
    variants: [
      {
        value: "claude-4.5-opus-high",
        variantLabel: "High",
        displayLabel: "Claude 4.5 Opus · High",
      },
      {
        value: "claude-4.5-opus-high-thinking",
        variantLabel: "High · Thinking",
        displayLabel: "Claude 4.5 Opus · High · Thinking",
      },
    ],
  },
  {
    id: "claude-4-sonnet",
    label: "Claude 4 Sonnet",
    variants: [
      {
        value: "claude-4-sonnet",
        variantLabel: "Default",
        displayLabel: "Claude 4 Sonnet",
      },
      {
        value: "claude-4-sonnet-thinking",
        variantLabel: "Thinking",
        displayLabel: "Claude 4 Sonnet · Thinking",
      },
    ],
  },
];
