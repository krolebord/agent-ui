import {
  deriveProvisionalTitleFromPrompt,
  isAutoManagedSessionTitle,
  type TitleGenerationSettings,
} from "@shared/title-generation";
import log from "./logger";
import { generateTitle } from "./title-generation";

interface TitleGenerationServiceOptions {
  getSettings: () => TitleGenerationSettings;
}

export interface TitleGenerationRequestParams {
  sessionId: string;
  prompt: string;
  defaultTitle: string;
  getTitle: () => string | undefined;
  setTitle: (title: string) => void;
}

export class TitleGenerationService {
  private readonly triggered = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly provisionalPromptBySession = new Map<string, string>();
  private readonly getSettings: () => TitleGenerationSettings;

  constructor(options: TitleGenerationServiceOptions) {
    this.getSettings = options.getSettings;
  }

  forget(sessionId: string): void {
    this.triggered.delete(sessionId);
    this.inFlight.delete(sessionId);
    this.provisionalPromptBySession.delete(sessionId);
  }

  private canAutoManageTitle(
    sessionId: string,
    currentTitle: string | undefined,
    defaultTitle: string,
    prompt: string,
  ): boolean {
    return isAutoManagedSessionTitle(
      currentTitle,
      defaultTitle,
      prompt,
      this.provisionalPromptBySession.get(sessionId),
    );
  }

  requestFromPrompt(params: TitleGenerationRequestParams): void {
    if (
      this.triggered.has(params.sessionId) ||
      this.inFlight.has(params.sessionId)
    ) {
      return;
    }

    const trimmedPrompt = params.prompt.trim();
    if (!trimmedPrompt) {
      return;
    }

    const provisionalTitle = deriveProvisionalTitleFromPrompt(trimmedPrompt);
    if (
      provisionalTitle &&
      this.canAutoManageTitle(
        params.sessionId,
        params.getTitle(),
        params.defaultTitle,
        trimmedPrompt,
      )
    ) {
      params.setTitle(provisionalTitle);
      this.provisionalPromptBySession.set(params.sessionId, trimmedPrompt);
    }

    this.inFlight.add(params.sessionId);
    log.info("Title generation triggered", { sessionId: params.sessionId });

    void generateTitle(this.getSettings(), trimmedPrompt)
      .then((title) => {
        if (!title) {
          log.warn("Title generation returned empty result", {
            sessionId: params.sessionId,
          });
          return;
        }

        this.triggered.add(params.sessionId);

        if (
          !this.canAutoManageTitle(
            params.sessionId,
            params.getTitle(),
            params.defaultTitle,
            trimmedPrompt,
          )
        ) {
          return;
        }

        log.info("Title generation completed", {
          sessionId: params.sessionId,
          title,
        });
        params.setTitle(title);
        this.provisionalPromptBySession.delete(params.sessionId);
      })
      .catch((error) => {
        log.error("Title generation failed", {
          sessionId: params.sessionId,
          error,
        });
      })
      .finally(() => {
        this.inFlight.delete(params.sessionId);
      });
  }
}
