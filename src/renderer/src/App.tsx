import { ConfirmDialog } from "@renderer/components/confirm-dialog";
import { NewSessionDialog } from "@renderer/components/new-session-dialog";
import { ProjectDefaultsDialog } from "@renderer/components/project-defaults-dialog";
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
import { WelcomePage } from "@renderer/components/welcome-page";
import { WorktreeDeleteDialog } from "@renderer/components/worktree-delete-dialog";
import { useAppShortcuts } from "@renderer/hooks/use-app-shortcuts";
import { useEffect } from "react";
import { useAppState } from "./components/sync-state-provider";
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

function useMainPage() {
  const activeSessionId = useActiveSessionId();

  return activeSessionId ? <SessionPage /> : <WelcomePage />;
}

function App() {
  useAppShortcuts();
  useValidateActiveSession();

  return (
    <>
      <div className="h-screen overflow-hidden">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize="18" minSize="12" maxSize="35">
            <SessionSidebar />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>
            <main className="flex h-full min-w-0 flex-col bg-black/15">
              {useMainPage()}
            </main>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <ConfirmDialog />
      <NewSessionDialog />
      <ProjectDefaultsDialog />
      <ProjectWorktreeDialog />
      <WorktreeDeleteDialog />
      <SettingsDialog />
      <Toaster closeButton />
    </>
  );
}

export default App;
