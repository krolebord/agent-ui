import { NewSessionDialog } from "@renderer/components/new-session-dialog";
import { ProjectDefaultsDialog } from "@renderer/components/project-defaults-dialog";
import { SessionPage } from "@renderer/components/session-page";
import { SessionSidebar } from "@renderer/components/session-sidebar";
import { SettingsDialog } from "@renderer/components/settings-dialog";
import { WelcomePage } from "@renderer/components/welcome-page";
import { Toaster } from "@renderer/components/ui/sonner";
import { useAppShortcuts } from "@renderer/hooks/use-app-shortcuts";
import { useEffect } from "react";
import {
  useActiveSessionId,
  useActiveSessionStore,
} from "./hooks/use-active-session-id";
import { useAppState } from "./components/sync-state-provider";

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
    <div className="flex h-screen overflow-hidden">
      <SessionSidebar />

      <main className="flex min-w-0 flex-1 flex-col bg-black/15">
        {useMainPage()}
      </main>

      <NewSessionDialog />

      <ProjectDefaultsDialog />

      <SettingsDialog />

      <Toaster />
    </div>
  );
}

export default App;
