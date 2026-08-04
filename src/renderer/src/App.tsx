import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { AddProjectDialog } from "@renderer/components/add-project-dialog";
import { ArtifactToastListener } from "@renderer/components/artifact-toast-listener";
import { ConfirmDialog } from "@renderer/components/confirm-dialog";
import { DiffReviewCommitDialog } from "@renderer/components/diff-review-commit-dialog";
import { ErrorDialog } from "@renderer/components/error-dialog";
import { InboxSidebar } from "@renderer/components/inbox-sidebar";
import { NewSessionDialog } from "@renderer/components/new-session-dialog";
import { ProjectCommandsDialog } from "@renderer/components/project-commands-dialog";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@renderer/components/ui/sheet";
import { Toaster } from "@renderer/components/ui/sonner";
import { WorktreeDeleteDialog } from "@renderer/components/worktree-delete-dialog";
import { useAppShortcuts } from "@renderer/hooks/use-app-shortcuts";
import { useAttentionFavicon } from "@renderer/hooks/use-attention-favicon";
import { useIsMobile } from "@renderer/hooks/use-is-mobile";
import { useMobileNavStore } from "@renderer/hooks/use-mobile-nav";
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

/** The session list, in whichever shape the user last chose. */
function SessionListSidebar() {
  const sidebarView = useAppState((state) => state.appSettings.sidebarView);

  return sidebarView === "inbox" ? <InboxSidebar /> : <SessionSidebar />;
}

function DesktopAppShell() {
  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel defaultSize="18" minSize="12" maxSize="35">
        <SessionListSidebar />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel>
        <main className="flex h-full min-w-0 flex-col bg-black/15">
          <SessionPage />
        </main>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function MobileAppShell() {
  const sidebarOpen = useMobileNavStore((state) => state.sidebarOpen);
  const setSidebarOpen = useMobileNavStore((state) => state.setSidebarOpen);

  return (
    <>
      <main className="flex h-full min-w-0 flex-col bg-black/15">
        <SessionPage />
      </main>
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="w-[85vw] max-w-sm gap-0 p-0"
        >
          <SheetTitle className="sr-only">Sessions</SheetTitle>
          <SheetDescription className="sr-only">
            Browse and switch between sessions
          </SheetDescription>
          <SessionListSidebar />
        </SheetContent>
      </Sheet>
    </>
  );
}

function App() {
  useAttentionFavicon();
  useAppShortcuts();
  useValidateActiveSession();
  const isMobile = useIsMobile();

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
        <div className="h-dvh overflow-hidden">
          {isMobile ? <MobileAppShell /> : <DesktopAppShell />}
        </div>
      </WorkerPoolContextProvider>

      <ConfirmDialog />
      <AddProjectDialog />
      <ErrorDialog />
      <NewSessionDialog />
      <ProjectDefaultsDialog />
      <ProjectCommandsDialog />
      <ProjectWorktreeDialog />
      <WorktreeDeleteDialog />
      <ProjectDeletionToastListener />
      <ArtifactToastListener />
      <SettingsDialog />
      <DiffReviewCommitDialog />
      <Toaster
        closeButton
        mobileOffset={{
          bottom: "calc(env(safe-area-inset-bottom) + 4rem)",
        }}
      />
    </>
  );
}

export default App;
