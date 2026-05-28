import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { ConfirmDialog } from "@renderer/components/confirm-dialog";
import { DiffReviewCommitDialog } from "@renderer/components/diff-review-commit-dialog";
import { ErrorDialog } from "@renderer/components/error-dialog";
import { NewSessionDialog } from "@renderer/components/new-session-dialog";
import { ProjectDefaultsDialog } from "@renderer/components/project-defaults-dialog";
import { ProjectDeletionToastListener } from "@renderer/components/project-deletion-toast-listener";
import { ProjectWorktreeDialog } from "@renderer/components/project-worktree-dialog";
import { SessionPage } from "@renderer/components/session-page";
import { SessionSidebar } from "@renderer/components/session-sidebar";
import { SettingsDialog } from "@renderer/components/settings-dialog";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@renderer/components/ui/resizable";
import { Toaster } from "@renderer/components/ui/sonner";
import { WorktreeDeleteDialog } from "@renderer/components/worktree-delete-dialog";
import { useAppShortcuts } from "@renderer/hooks/use-app-shortcuts";
import { useEffect } from "react";
import { useAppState } from "./components/sync-state-provider";
import { diffsWorkerFactory } from "./diff-worker";
import {
  useActiveSessionId,
  useActiveSessionStore,
} from "./hooks/use-active-session-id";

function useValidateActiveSession() {
  const activeSessionId = useActiveSessionId();
  const sessions = useAppState((state) => state.sessions);

  useEffect(() => {
    if (activeSessionId && !sessions[activeSessionId]) {
      useActiveSessionStore.getState().setActiveSessionId(null);
    }
  }, [activeSessionId, sessions]);
}

function App() {
  useAppShortcuts();
  useValidateActiveSession();

  return (
    <>
      <WorkerPoolContextProvider
        poolOptions={{
          workerFactory: diffsWorkerFactory,
        }}
        highlighterOptions={{
          theme: { dark: "pierre-dark", light: "pierre-light" },
          langs: ["typescript", "javascript", "css", "html"],
        }}
      >
        <div className="h-screen overflow-hidden">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel defaultSize="18" minSize="12" maxSize="35">
              <SessionSidebar />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel>
              <main className="flex h-full min-w-0 flex-col bg-black/15">
                <SessionPage />
              </main>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </WorkerPoolContextProvider>

      <ConfirmDialog />
      <ErrorDialog />
      <NewSessionDialog />
      <ProjectDefaultsDialog />
      <ProjectWorktreeDialog />
      <WorktreeDeleteDialog />
      <ProjectDeletionToastListener />
      <SettingsDialog />
      <DiffReviewCommitDialog />
      <Toaster closeButton />
    </>
  );
}

export default App;
