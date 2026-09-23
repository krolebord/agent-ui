import type { CodexModelReasoningEffort } from "./codex-types";

export interface CodexModel {
  label: string;
  value: string;
  defaultReasoningEffort?: CodexModelReasoningEffort;
  supportedReasoningEfforts: CodexModelReasoningEffort[];
  supportsFastMode: boolean;
  upgradeTo?: string;
}

export const codexModels: CodexModel[] = [
  {
    label: "GPT-6-Sol",
    value: "gpt-6-sol",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ],
    supportsFastMode: true,
  },
  {
    label: "GPT-6-Astra",
    value: "gpt-6-astra",
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ],
    supportsFastMode: true,
  },
  {
    label: "GPT-6-Luna",
    value: "gpt-6-luna",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportsFastMode: true,
  },
  {
    label: "GPT-5.6-Sol",
    value: "gpt-5.6-sol",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ],
    supportsFastMode: true,
  },
  {
    label: "GPT-5.6-Terra",
    value: "gpt-5.6-terra",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ],
    supportsFastMode: true,
  },
  {
    label: "GPT-5.6-Luna",
    value: "gpt-5.6-luna",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportsFastMode: true,
  },
  {
    label: "GPT-5.5",
    value: "gpt-5.5",
    defaultReasoningEffort: "xhigh",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    supportsFastMode: true,
    upgradeTo: "gpt-5.6-sol",
  },
];
