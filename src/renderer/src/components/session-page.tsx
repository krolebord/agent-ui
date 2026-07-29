import { ProjectDiffPane } from "@renderer/components/diff-review-pane";
import { ProjectGitHistoryPane } from "@renderer/components/git-history-pane";
import { LiveTerminalSurface } from "@renderer/components/live-terminal-surface";
import { MobileSidebarTrigger } from "@renderer/components/mobile-sidebar-trigger";
import { ProjectBottomPane } from "@renderer/components/project-bottom-pane";
import { ProjectTerminalPane } from "@renderer/components/project-terminal-pane";
import { SessionHeader } from "@renderer/components/session-header";
import { TerminalKeyBar } from "@renderer/components/terminal-key-bar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/ui/collapsible";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@renderer/components/ui/resizable";
import { useActiveSessionId } from "@renderer/hooks/use-active-session-id";
import { useIsMobile } from "@renderer/hooks/use-is-mobile";
import { useMainViewStore } from "@renderer/hooks/use-main-view";
import { cn } from "@renderer/lib/utils";
import {
  AlertCircle,
  ChevronRight,
  CircleCheck,
  CircleX,
  FileDiff,
  History,
  LoaderCircle,
  SquareTerminal,
  TerminalSquare,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { AccountsPage } from "./accounts-page";
import { ScheduledSessionsPage } from "./scheduled-sessions-page";
import { SkillsPage } from "./skills-page";
import { useAppState } from "./sync-state-provider";
import { WelcomePage } from "./welcome-page";

function useActiveSession() {
  const activeSessionId = useActiveSessionId();
  const sessions = useAppState((state) => state.sessions);
  return activeSessionId ? (sessions[activeSessionId] ?? null) : null;
}

type Session = Exclude<ReturnType<typeof useActiveSession>, null>;

type MobileTab = "session" | "diff" | "history" | "terminals";

const mobileTabItems: Array<{
  tab: MobileTab;
  icon: typeof SquareTerminal;
  label: string;
}> = [
  { tab: "session", icon: SquareTerminal, label: "Session" },
  { tab: "diff", icon: FileDiff, label: "Diff" },
  { tab: "history", icon: History, label: "History" },
  { tab: "terminals", icon: TerminalSquare, label: "Shell" },
];

function MobileWelcomeBar() {
  return (
    <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/70 px-2 py-1.5 md:hidden">
      <MobileSidebarTrigger />
      <span className="text-sm font-medium">Agent UI</span>
    </div>
  );
}

export function SessionPage() {
  const session = useActiveSession();
  const projectCount = useAppState((state) => state.projects.length);
  const mainView = useMainViewStore((state) => state.view);

  if (mainView === "skills") {
    return <SkillsPage />;
  }

  if (mainView === "scheduledSessions") {
    return <ScheduledSessionsPage />;
  }

  if (mainView === "accounts") {
    return <AccountsPage />;
  }

  if (!session) {
    return (
      <SessionPageLayout
        topPane={
          <div className="flex h-full min-h-0 flex-col">
            <MobileWelcomeBar />
            <div className="min-h-0 flex-1">
              <WelcomePage hasProjects={projectCount > 0} />
            </div>
          </div>
        }
        cwd={null}
      />
    );
  }

  switch (session.type) {
    case "claude-local-terminal":
      return <TerminalPage session={session} cwd={session.startupConfig.cwd} />;
    case "local-terminal":
      return null;
    case "codex-local-terminal":
      return <TerminalPage session={session} cwd={session.startupConfig.cwd} />;
    case "cursor-agent":
      return <TerminalPage session={session} cwd={session.startupConfig.cwd} />;
    case "worktree-setup":
      return <WorktreeSetupSessionPage session={session} />;
    default:
      return null;
  }
}

function WorktreeSetupSessionPage({
  session,
}: {
  session: Extract<Session, { type: "worktree-setup" }>;
}) {
  return (
    <SessionPageLayout
      topPane={
        <div className="flex h-full min-h-0 flex-col">
          <SessionHeader session={session} />
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-4">
            {session.steps.map((step, index) => (
              <WorktreeSetupStepRow
                key={`${index}-${step.command}`}
                step={step}
              />
            ))}
          </div>
        </div>
      }
      cwd={session.startupConfig.cwd}
    />
  );
}

function WorktreeSetupStepRow({
  step,
}: {
  step: Extract<Session, { type: "worktree-setup" }>["steps"][number];
}) {
  const isError = step.status === "error";
  const isRunning = step.status === "running";
  const isPending = step.status === "pending";

  return (
    <Collapsible defaultOpen={isRunning || isError}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/50">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        {isRunning ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : isError ? (
          <CircleX className="size-3.5 shrink-0 text-rose-400" />
        ) : isPending ? (
          <span className="size-3.5 shrink-0 text-muted-foreground">○</span>
        ) : (
          <CircleCheck className="size-3.5 shrink-0 text-emerald-400" />
        )}
        <code className="truncate">{step.command}</code>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {step.output ? (
          <pre className="mx-2 mb-1 max-h-60 overflow-auto rounded border border-border/60 bg-muted/30 p-2 font-mono text-xs whitespace-pre-wrap">
            {step.output}
            {step.outputTruncated ? (
              <span className="text-muted-foreground"> (truncated)</span>
            ) : null}
          </pre>
        ) : null}
        {isError && step.errorMessage ? (
          <pre className="mx-2 mb-1 max-h-40 overflow-auto rounded border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-300 whitespace-pre-wrap">
            {step.errorMessage}
          </pre>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function TerminalPage({
  session,
  readOnly,
  controls,
  cwd,
}: {
  session: Session;
  readOnly?: boolean;
  controls?: ReactNode;
  cwd: string | null;
}) {
  const isMobile = useIsMobile();
  const errorMessage = session.errorMessage || session.warningMessage || "";
  const terminalAttachmentState =
    session.status === "stopped" || session.status === "error"
      ? "offline"
      : "live";

  return (
    <SessionPageLayout
      cwd={cwd}
      topPane={
        <div className="flex h-full min-h-0 flex-col">
          <SessionHeader session={session} />
          {controls}
          {errorMessage ? (
            <div className="mx-4 mt-4 flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              <AlertCircle className="size-4" />
              <span>{errorMessage}</span>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-hidden">
            <LiveTerminalSurface
              terminalId={session.sessionId}
              initialBuffer={session.offlineBuffer}
              readOnly={readOnly}
              attachKey={`${session.sessionId}:${terminalAttachmentState}`}
            />
          </div>
          {isMobile ? (
            <TerminalKeyBar
              terminalId={session.sessionId}
              sessionType={session.type}
            />
          ) : null}
        </div>
      }
    />
  );
}

function SessionPageLayout({
  topPane,
  cwd,
}: {
  topPane: ReactNode;
  cwd: string | null;
}) {
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState<MobileTab>("session");

  if (isMobile) {
    if (!cwd) {
      return <div className="min-h-0 flex-1">{topPane}</div>;
    }

    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          <div
            className={cn(
              "min-h-0 h-full",
              activeTab !== "session" && "hidden",
            )}
          >
            {topPane}
          </div>
          {activeTab === "diff" ? (
            <div className="min-h-0 h-full">
              <ProjectDiffPane cwd={cwd} />
            </div>
          ) : null}
          {activeTab === "history" ? (
            <div className="min-h-0 h-full">
              <ProjectGitHistoryPane cwd={cwd} />
            </div>
          ) : null}
          {activeTab === "terminals" ? (
            <div className="min-h-0 h-full">
              <ProjectTerminalPane cwd={cwd} />
            </div>
          ) : null}
        </div>
        <nav className="shrink-0 border-t border-border/70 bg-background pb-[env(safe-area-inset-bottom)]">
          <div className="flex h-12">
            {mobileTabItems.map(({ tab, icon: TabIcon, label }) => (
              <button
                key={tab}
                type="button"
                className={cn(
                  "flex flex-1 flex-col items-center justify-center gap-0.5",
                  activeTab === tab
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
                aria-pressed={activeTab === tab}
                onClick={() => setActiveTab(tab)}
              >
                <TabIcon className="size-4" />
                <span className="text-[10px]">{label}</span>
              </button>
            ))}
          </div>
        </nav>
      </div>
    );
  }

  return (
    <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
      <ResizablePanel defaultSize={70} minSize={35}>
        {topPane}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={30} minSize={15}>
        <ProjectBottomPane cwd={cwd} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
