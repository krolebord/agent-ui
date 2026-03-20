import { orpc } from "@renderer/orpc-client";
import {
  type OpenInAppTarget,
  openInAppTargetLabels,
} from "@shared/open-in-app";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  FolderOpen,
  Github,
  Repeat,
  TerminalSquare,
} from "lucide-react";
import {
  type ComponentType,
  type SVGProps,
  useEffect,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import type { Session } from "src/main/sessions/state";
import { create } from "zustand";
import { combine, persist } from "zustand/middleware";
import {
  ClaudeCodeIcon,
  CodexIcon,
  CursorAgentIcon,
} from "./session-type-icons";
import { useAppState } from "./sync-state-provider";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

const STORAGE_KEY = "agent-ui:sessionHeaderOpenApp";

const sessionTypeConfig: Record<
  Session["type"],
  { icon: ComponentType<SVGProps<SVGSVGElement>> }
> = {
  "claude-local-terminal": { icon: ClaudeCodeIcon },
  "local-terminal": { icon: TerminalSquare },
  "ralph-loop": { icon: Repeat },
  "codex-local-terminal": { icon: CodexIcon },
  "cursor-agent": { icon: CursorAgentIcon },
};

const openInAppItems: Array<{
  app: OpenInAppTarget;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}> = [
  { app: "cursor", icon: CursorAgentIcon },
  { app: "finder", icon: FolderOpen },
  { app: "github-desktop", icon: Github },
  { app: "terminal", icon: TerminalSquare },
];

const openInAppItemsByTarget = Object.fromEntries(
  openInAppItems.map((item) => [item.app, item]),
) as Record<
  OpenInAppTarget,
  {
    app: OpenInAppTarget;
    icon: ComponentType<SVGProps<SVGSVGElement>>;
  }
>;

const useSessionHeaderOpenAppStore = create(
  persist(
    combine(
      {
        preferredApp: "finder" as OpenInAppTarget,
      },
      (set) => ({
        setPreferredApp: (preferredApp: OpenInAppTarget) => {
          set({ preferredApp });
        },
      }),
    ),
    {
      name: STORAGE_KEY,
    },
  ),
);

export function SessionHeader({ session }: { session: Session }) {
  const Icon = sessionTypeConfig[session.type]?.icon;
  const [menuOpen, setMenuOpen] = useState(false);
  const preferredApp = useSessionHeaderOpenAppStore(
    (state) => state.preferredApp,
  );
  const setPreferredApp = useSessionHeaderOpenAppStore(
    (state) => state.setPreferredApp,
  );

  const activeProject = useAppState((state) =>
    state.projects.find(
      (project) => project.path === session.startupConfig.cwd,
    ),
  );
  const addedLines =
    activeProject?.gitDiffStats && activeProject.gitDiffStats.addedLines > 0
      ? activeProject.gitDiffStats.addedLines
      : undefined;
  const deletedLines =
    activeProject?.gitDiffStats && activeProject.gitDiffStats.deletedLines > 0
      ? activeProject.gitDiffStats.deletedLines
      : undefined;
  const aheadCommits =
    activeProject?.gitUpstreamDiffStats &&
    activeProject.gitUpstreamDiffStats.aheadCommits > 0
      ? activeProject.gitUpstreamDiffStats.aheadCommits
      : undefined;
  const behindCommits =
    activeProject?.gitUpstreamDiffStats &&
    activeProject.gitUpstreamDiffStats.behindCommits > 0
      ? activeProject.gitUpstreamDiffStats.behindCommits
      : undefined;

  const { refetch } = useQuery(
    orpc.projects.refreshProject.queryOptions({
      input: activeProject
        ? {
            path: activeProject.path,
          }
        : skipToken,
      enabled: !!activeProject,
    }),
  );

  useEffect(() => {
    if (session.status === "awaiting_user_response") {
      void refetch();
    }
  }, [refetch, session.status]);

  const openFolderInAppMutation = useMutation({
    mutationFn: async (app: OpenInAppTarget) => {
      await orpc.fs.openFolderInApp.call({
        path: session.startupConfig.cwd,
        app,
      });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error && error.message.trim()
          ? error.message
          : "Failed to open folder",
      );
    },
  });

  const openFolder = (app: OpenInAppTarget) => {
    openFolderInAppMutation.mutate(app);
  };

  const preferredAppItem = useMemo(
    () => openInAppItemsByTarget[preferredApp] ?? openInAppItemsByTarget.finder,
    [preferredApp],
  );
  const PreferredAppIcon = preferredAppItem.icon;

  return (
    <header className="flex min-h-11 shrink-0 items-center gap-3 border-b border-border/70 px-2 py-1.5">
      {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{session.title}</div>
        {activeProject?.gitBranch ? (
          <div className="truncate text-xs text-muted-foreground">
            {activeProject.gitBranch}
          </div>
        ) : null}
      </div>
      {addedLines || deletedLines || aheadCommits || behindCommits ? (
        <div className="shrink-0 font-mono text-xs text-muted-foreground">
          {addedLines ? (
            <span className="text-emerald-400">+{addedLines}</span>
          ) : null}
          {deletedLines ? (
            <span
              className={addedLines ? "ml-2 text-rose-400" : "text-rose-400"}
            >
              -{deletedLines}
            </span>
          ) : null}
          {aheadCommits ? (
            <span className={addedLines || deletedLines ? "ml-2" : undefined}>
              ↑{aheadCommits}
            </span>
          ) : null}
          {behindCommits ? (
            <span
              className={
                addedLines || deletedLines || aheadCommits ? "ml-2" : undefined
              }
            >
              ↓{behindCommits}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="flex shrink-0 items-center">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={openFolderInAppMutation.isPending}
          className="rounded-r-none border-r-0 text-xs"
          onClick={() => {
            openFolder(preferredApp);
          }}
        >
          <PreferredAppIcon className="size-3.5 text-muted-foreground" />
          <span>Open</span>
        </Button>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={openFolderInAppMutation.isPending}
              className="rounded-l-none px-2 text-xs"
            >
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuLabel>Open in</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {openInAppItems.map(({ app, icon: AppIcon }) => (
              <DropdownMenuItem
                key={app}
                disabled={openFolderInAppMutation.isPending}
                onClick={() => {
                  setPreferredApp(app);
                  setMenuOpen(false);
                  openFolder(app);
                }}
              >
                <AppIcon className="size-4" />
                {openInAppTargetLabels[app]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
