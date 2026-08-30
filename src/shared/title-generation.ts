import z from "zod";

export const codexTextGenerationModel = "gpt-5.6-luna";
export const cursorTextGenerationDefaultModel = "composer-2.5";

export const titleGenerationProviders = ["codex", "cursor"] as const;

export type TitleGenerationProvider = (typeof titleGenerationProviders)[number];

export type TitleGenerationSettings =
  | {
      provider: "codex";
      model: typeof codexTextGenerationModel;
    }
  | {
      provider: "cursor";
      model: string;
    };

export const defaultTitleGenerationSettings: TitleGenerationSettings = {
  provider: "codex",
  model: codexTextGenerationModel,
};

export const titleGenerationSettingsSchema = z
  .discriminatedUnion("provider", [
    z.object({
      provider: z.literal("codex"),
      model: z
        .literal(codexTextGenerationModel)
        .catch(codexTextGenerationModel),
    }),
    z.object({
      provider: z.literal("cursor"),
      model: z.string().trim().min(1).catch(cursorTextGenerationDefaultModel),
    }),
  ])
  .catch(defaultTitleGenerationSettings);

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
