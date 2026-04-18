import { LiveTerminalSurface } from "@renderer/components/live-terminal-surface";
import { ProjectTerminalPane } from "@renderer/components/project-terminal-pane";
import { SessionHeader } from "@renderer/components/session-header";
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
import {
  AlertCircle,
  ChevronRight,
  CircleCheck,
  CircleX,
  LoaderCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { useAppState } from "./sync-state-provider";
import { WelcomePage } from "./welcome-page";

function useActiveSession() {
  const activeSessionId = useActiveSessionId();
  const sessions = useAppState((state) => state.sessions);
  return activeSessionId ? (sessions[activeSessionId] ?? null) : null;
}

type Session = Exclude<ReturnType<typeof useActiveSession>, null>;

export function SessionPage() {
  const session = useActiveSession();
  const projectCount = useAppState((state) => state.projects.length);

  if (!session) {
    return (
      <SessionPageLayout
        topPane={<WelcomePage hasProjects={projectCount > 0} />}
        bottomPane={<ProjectTerminalPane cwd={null} />}
      />
    );
  }

  switch (session.type) {
    case "claude-local-terminal":
      return (
        <TerminalPage
          session={session}
          bottomPane={<ProjectTerminalPane cwd={session.startupConfig.cwd} />}
        />
      );
    case "local-terminal":
      return null;
    case "codex-local-terminal":
      return (
        <TerminalPage
          session={session}
          bottomPane={<ProjectTerminalPane cwd={session.startupConfig.cwd} />}
        />
      );
    case "cursor-agent":
      return (
        <TerminalPage
          session={session}
          bottomPane={<ProjectTerminalPane cwd={session.startupConfig.cwd} />}
        />
      );
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
      bottomPane={<ProjectTerminalPane cwd={session.startupConfig.cwd} />}
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
  bottomPane,
}: {
  session: Session;
  readOnly?: boolean;
  controls?: ReactNode;
  bottomPane?: ReactNode;
}) {
  const errorMessage = session.errorMessage || session.warningMessage || "";

  return (
    <SessionPageLayout
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
              readOnly={readOnly}
            />
          </div>
        </div>
      }
      bottomPane={bottomPane}
    />
  );
}

function SessionPageLayout({
  topPane,
  bottomPane,
}: {
  topPane: ReactNode;
  bottomPane?: ReactNode;
}) {
  return (
    <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
      <ResizablePanel defaultSize={70} minSize={35}>
        {topPane}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={30} minSize={15}>
        {bottomPane ?? <div className="h-full bg-black/10" />}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
