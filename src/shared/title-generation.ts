import z from "zod";

export const titleGenerationProviders = ["cursor"] as const;

export type TitleGenerationProvider = (typeof titleGenerationProviders)[number];

export interface TitleGenerationSettings {
  provider: TitleGenerationProvider;
  model: string;
}

export const defaultTitleGenerationSettings: TitleGenerationSettings = {
  provider: "cursor",
  model: "composer-2.5",
};

export const titleGenerationSettingsSchema = z.object({
  provider: z.enum(titleGenerationProviders).catch("cursor"),
  model: z.string().trim().min(1).catch("composer-2.5"),
});

export const provisionalSessionTitleMaxLength = 100;

export function deriveProvisionalTitleFromPrompt(
  prompt: string,
): string | null {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.length <= provisionalSessionTitleMaxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, provisionalSessionTitleMaxLength)}...`;
}

export function isAutoManagedSessionTitle(
  currentTitle: string | undefined,
  defaultTitle: string,
  prompt: string,
  priorPrompt?: string,
): boolean {
  if (!currentTitle) {
    return false;
  }

  if (currentTitle === defaultTitle) {
    return true;
  }

  const provisional = deriveProvisionalTitleFromPrompt(prompt);
  if (provisional !== null && currentTitle === provisional) {
    return true;
  }

  if (!priorPrompt) {
    return false;
  }

  const priorProvisional = deriveProvisionalTitleFromPrompt(priorPrompt);
  return priorProvisional !== null && currentTitle === priorProvisional;
}
