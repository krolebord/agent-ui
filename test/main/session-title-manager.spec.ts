import { describe, expect, it, vi } from "vitest";
import { SessionTitleManager } from "../../src/main/session-title-manager";

function createTitleManager(
  generateTitle = vi.fn<(prompt: string) => Promise<string>>(),
) {
  const manager = new SessionTitleManager({ generateTitle });
  return { manager, generateTitle };
}

describe("SessionTitleManager", () => {
  describe("maybeGenerate", () => {
    it("calls generateTitle with the prompt", async () => {
      const { manager, generateTitle } = createTitleManager(
        vi.fn().mockResolvedValue("Test Title"),
      );

      const onTitleReady = vi.fn();
      manager.maybeGenerate({
        sessionId: "s1",
        prompt: "Hello world",
        sessionExists: () => true,
        onTitleReady,
      });

      await vi.waitFor(() => {
        expect(generateTitle).toHaveBeenCalledWith("Hello world");
        expect(onTitleReady).toHaveBeenCalledWith("Test Title");
      });
    });

    it("does not call onTitleReady if session no longer exists", async () => {
      const { manager } = createTitleManager(
        vi.fn().mockResolvedValue("Title"),
      );

      const onTitleReady = vi.fn();
      manager.maybeGenerate({
        sessionId: "s1",
        prompt: "Hello",
        sessionExists: () => false,
        onTitleReady,
      });

      await vi.waitFor(() => {
        expect(onTitleReady).not.toHaveBeenCalled();
      });
    });

    it("only triggers once per session", async () => {
      const { manager, generateTitle } = createTitleManager(
        vi.fn().mockResolvedValue("Title"),
      );

      manager.maybeGenerate({
        sessionId: "s1",
        prompt: "First",
        sessionExists: () => true,
        onTitleReady: vi.fn(),
      });

      manager.maybeGenerate({
        sessionId: "s1",
        prompt: "Second",
        sessionExists: () => true,
        onTitleReady: vi.fn(),
      });

      await vi.waitFor(() => {
        expect(generateTitle).toHaveBeenCalledTimes(1);
        expect(generateTitle).toHaveBeenCalledWith("First");
      });
    });

    it("does not generate if already marked triggered", () => {
      const { manager, generateTitle } = createTitleManager();

      manager.markTriggered("s1");
      manager.maybeGenerate({
        sessionId: "s1",
        prompt: "Hello",
        sessionExists: () => true,
        onTitleReady: vi.fn(),
      });

      expect(generateTitle).not.toHaveBeenCalled();
    });

    it("does not throw when generateTitle rejects", async () => {
      const { manager } = createTitleManager(
        vi.fn().mockRejectedValue(new Error("fail")),
      );

      manager.maybeGenerate({
        sessionId: "s1",
        prompt: "Hello",
        sessionExists: () => true,
        onTitleReady: vi.fn(),
      });

      // Should not throw — wait a tick for the rejection to settle
      await new Promise((r) => setTimeout(r, 10));
    });
  });

  describe("forget", () => {
    it("allows re-triggering after forget", async () => {
      const { manager, generateTitle } = createTitleManager(
        vi.fn().mockResolvedValue("Title"),
      );

      manager.markTriggered("s1");
      manager.forget("s1");

      manager.maybeGenerate({
        sessionId: "s1",
        prompt: "New prompt",
        sessionExists: () => true,
        onTitleReady: vi.fn(),
      });

      await vi.waitFor(() => {
        expect(generateTitle).toHaveBeenCalledWith("New prompt");
      });
    });
  });
});
