import { beforeEach, describe, expect, it, vi } from "vitest";
import { TitleGenerationService } from "../../src/main/title-generation-service";

const generateTitleMock = vi.hoisted(() =>
  vi.fn<(prompt: string) => Promise<string | null>>(),
);

vi.mock("../../src/main/title-generation", () => ({
  generateTitle: (_settings: unknown, prompt: string) =>
    generateTitleMock(prompt),
}));

function createService() {
  return new TitleGenerationService({
    getSettings: () => ({ provider: "cursor", model: "composer-2-fast" }),
  });
}

function createTitleState(initialTitle = "Default Session") {
  let title = initialTitle;
  return {
    getTitle: () => title,
    setTitle: (nextTitle: string) => {
      title = nextTitle;
    },
    get current() {
      return title;
    },
  };
}

describe("TitleGenerationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets a provisional title synchronously before generation completes", async () => {
    let resolveGeneration: (title: string | null) => void = () => {};
    generateTitleMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGeneration = resolve;
        }),
    );

    const service = createService();
    const titleState = createTitleState();

    service.requestFromPrompt({
      sessionId: "s1",
      prompt: "Hello world",
      defaultTitle: "Default Session",
      getTitle: titleState.getTitle,
      setTitle: titleState.setTitle,
    });

    expect(titleState.current).toBe("Hello world");
    resolveGeneration("Test Title");

    await vi.waitFor(() => {
      expect(titleState.current).toBe("Test Title");
    });
  });

  it("truncates long prompts for the provisional title", () => {
    generateTitleMock.mockResolvedValue(null);
    const service = createService();
    const titleState = createTitleState();
    const longPrompt = "a".repeat(150);

    service.requestFromPrompt({
      sessionId: "s1",
      prompt: longPrompt,
      defaultTitle: "Default Session",
      getTitle: titleState.getTitle,
      setTitle: titleState.setTitle,
    });

    expect(titleState.current).toBe(`${"a".repeat(100)}...`);
  });

  it("calls generateTitle with the prompt", async () => {
    generateTitleMock.mockResolvedValue("Test Title");
    const service = createService();
    const titleState = createTitleState();

    service.requestFromPrompt({
      sessionId: "s1",
      prompt: "Hello world",
      defaultTitle: "Default Session",
      getTitle: titleState.getTitle,
      setTitle: titleState.setTitle,
    });

    await vi.waitFor(() => {
      expect(generateTitleMock).toHaveBeenCalledWith("Hello world");
      expect(titleState.current).toBe("Test Title");
    });
  });

  it("does not overwrite a manually renamed title", async () => {
    generateTitleMock.mockResolvedValue("Test Title");
    const service = createService();
    const titleState = createTitleState();

    service.requestFromPrompt({
      sessionId: "s1",
      prompt: "Hello world",
      defaultTitle: "Default Session",
      getTitle: titleState.getTitle,
      setTitle: titleState.setTitle,
    });

    titleState.setTitle("Manually renamed");

    await vi.waitFor(() => {
      expect(generateTitleMock).toHaveBeenCalled();
    });

    expect(titleState.current).toBe("Manually renamed");
  });

  it("only triggers once per session after success", async () => {
    generateTitleMock.mockResolvedValue("Title");
    const service = createService();

    service.requestFromPrompt({
      sessionId: "s1",
      prompt: "First",
      defaultTitle: "Default Session",
      getTitle: () => "Default Session",
      setTitle: vi.fn(),
    });

    service.requestFromPrompt({
      sessionId: "s1",
      prompt: "Second",
      defaultTitle: "Default Session",
      getTitle: () => "Default Session",
      setTitle: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(generateTitleMock).toHaveBeenCalledTimes(1);
      expect(generateTitleMock).toHaveBeenCalledWith("First");
    });
  });

  it("allows retry when generation returns empty", async () => {
    generateTitleMock.mockResolvedValueOnce(null);
    const service = createService();
    const titleState = createTitleState();

    service.requestFromPrompt({
      sessionId: "s1",
      prompt: "First",
      defaultTitle: "Default Session",
      getTitle: titleState.getTitle,
      setTitle: titleState.setTitle,
    });

    await vi.waitFor(() => {
      expect(generateTitleMock).toHaveBeenCalledTimes(1);
    });

    expect(titleState.current).toBe("First");

    await new Promise((resolve) => setTimeout(resolve, 0));

    generateTitleMock.mockResolvedValueOnce("Title");
    service.requestFromPrompt({
      sessionId: "s1",
      prompt: "Second",
      defaultTitle: "Default Session",
      getTitle: titleState.getTitle,
      setTitle: titleState.setTitle,
    });

    await vi.waitFor(() => {
      expect(generateTitleMock).toHaveBeenCalledTimes(2);
      expect(titleState.current).toBe("Title");
    });
  });

  it("does not throw when generateTitle rejects", async () => {
    generateTitleMock.mockRejectedValue(new Error("fail"));
    const service = createService();
    const titleState = createTitleState();

    service.requestFromPrompt({
      sessionId: "s1",
      prompt: "Hello",
      defaultTitle: "Default Session",
      getTitle: titleState.getTitle,
      setTitle: titleState.setTitle,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(titleState.current).toBe("Hello");
  });

  describe("forget", () => {
    it("allows re-triggering after forget", async () => {
      generateTitleMock.mockResolvedValue("Title");
      const service = createService();

      service.requestFromPrompt({
        sessionId: "s1",
        prompt: "First",
        defaultTitle: "Default Session",
        getTitle: () => "Default Session",
        setTitle: vi.fn(),
      });

      await vi.waitFor(() => {
        expect(generateTitleMock).toHaveBeenCalledTimes(1);
      });

      service.forget("s1");

      service.requestFromPrompt({
        sessionId: "s1",
        prompt: "New prompt",
        defaultTitle: "Default Session",
        getTitle: () => "Default Session",
        setTitle: vi.fn(),
      });

      await vi.waitFor(() => {
        expect(generateTitleMock).toHaveBeenCalledWith("New prompt");
        expect(generateTitleMock).toHaveBeenCalledTimes(2);
      });
    });
  });
});
