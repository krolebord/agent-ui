import { LiveTerminalSurface } from "@renderer/components/live-terminal-surface";
import { TerminalKeyBar } from "@renderer/components/terminal-key-bar";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@renderer/components/ui/resizable";
import { useIsMobile } from "@renderer/hooks/use-is-mobile";
import { getTerminalSize } from "@renderer/hooks/use-terminal-size";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ChevronDown,
  CircleDot,
  LoaderCircle,
  Play,
  Plus,
  RotateCw,
  TerminalSquare,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useProjectCommandsDialogStore } from "./project-commands-dialog";
import { useAppState } from "./sync-state-provider";

function getTerminalStatusMeta(status: string) {
  switch (status) {
    case "running":
      return {
        icon: CircleDot,
        className: "text-emerald-400",
        label: "Running",
        animate: false,
      };
    case "stopping":
      return {
        icon: LoaderCircle,
        className: "text-amber-400",
        label: "Stopping",
        animate: true,
      };
    case "error":
      return {
        icon: AlertCircle,
        className: "text-rose-400",
        label: "Error",
        animate: false,
      };
    case "stopped":
      return {
        icon: CircleDot,
        className: "text-zinc-600",
        label: "Stopped",
        animate: false,
      };
    default:
      return {
        icon: CircleDot,
        className: "text-zinc-400",
        label: status === "starting" ? "Starting" : "Idle",
        animate: false,
      };
  }
}

/**
 * Lists the project's command presets, then the scripts discovered in its
 * `package.json`. The list is fetched when the menu opens rather than cached:
 * both sources are edited outside the app.
 */
function ProjectCommandsMenu({
  cwd,
  disabled,
  triggerClassName,
  onRun,
}: {
  cwd: string;
  disabled: boolean;
  triggerClassName: string;
  onRun: (commandId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const setCommandsDialogCwd = useProjectCommandsDialogStore(
    (s) => s.setOpenProjectCwd,
  );

  const commandsQuery = useQuery({
    ...orpc.projects.listCommands.queryOptions({ input: { path: cwd } }),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });
  const commands = commandsQuery.data?.commands ?? [];
  const scripts = commandsQuery.data?.scripts ?? [];

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="flat"
          className={triggerClassName}
          disabled={disabled}
          aria-label="Project commands"
        >
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Commands</DropdownMenuLabel>
        {commandsQuery.isPending ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : commands.length === 0 && scripts.length === 0 ? (
          <DropdownMenuItem disabled>
            None in .agent-ui/settings.jsonc
          </DropdownMenuItem>
        ) : (
          commands.map((command) => (
            <DropdownMenuItem
              key={command.id}
              onSelect={() => {
                onRun(command.id);
              }}
            >
              <Play className="size-3.5" />
              <span className="truncate">{command.name}</span>
            </DropdownMenuItem>
          ))
        )}
        {scripts.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              package.json
            </DropdownMenuLabel>
            {scripts.map((script) => (
              <DropdownMenuItem
                key={script.id}
                onSelect={() => {
                  onRun(script.id);
                }}
              >
                <Play className="size-3.5" />
                <span className="truncate">{script.name}</span>
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            setCommandsDialogCwd(cwd);
          }}
        >
          Manage commands…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectTerminalSurface({
  terminalId,
  isActive,
  projectLocked,
}: {
  terminalId: string;
  isActive: boolean;
  projectLocked: boolean;
}) {
  return (
    <div
      className={cn(
        "absolute inset-0 h-full min-h-0",
        !isActive && "hidden",
        isActive && projectLocked && "pointer-events-none opacity-60",
      )}
      aria-hidden={!isActive}
    >
      <LiveTerminalSurface
        terminalId={terminalId}
        active={isActive}
        readOnly={!isActive || projectLocked}
        trackGlobalSize={false}
      />
    </div>
  );
}

function ProjectTerminalStack({
  hasCwd,
  workspace,
  activeTerminalId,
  projectLocked,
  isCreating,
  onCreateTerminal,
}: {
  hasCwd: boolean;
  workspace: {
    selectedTerminalId: string | null;
    order: string[];
    terminals: Record<
      string,
      {
        title: string;
        status: string;
      }
    >;
  } | null;
  activeTerminalId: string | null;
  projectLocked: boolean;
  isCreating: boolean;
  onCreateTerminal: () => void;
}) {
  return (
    <div className="h-full min-w-0 bg-black/10">
      {!hasCwd ? (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-xs space-y-2 text-center">
            <p className="text-sm text-zinc-300">
              Select a session to view project terminals.
            </p>
            <p className="text-xs text-zinc-500">
              The terminal and project pane layout stays available here, even
              when no session is selected.
            </p>
          </div>
        </div>
      ) : activeTerminalId && workspace?.terminals[activeTerminalId] ? (
        <div className="relative h-full min-h-0">
          {workspace.order.map((terminalId) => {
            const terminal = workspace.terminals[terminalId];
            if (!terminal) {
              return null;
            }

            return (
              <ProjectTerminalSurface
                key={terminalId}
                terminalId={terminalId}
                isActive={terminalId === activeTerminalId}
                projectLocked={projectLocked}
              />
            );
          })}
        </div>
      ) : (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-xs space-y-3 text-center">
            <p className="text-sm text-zinc-300">
              No terminal selected for this project.
            </p>
            <Button
              variant="outline"
              onClick={() => {
                onCreateTerminal();
              }}
              disabled={isCreating || projectLocked}
            >
              Create terminal
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ProjectTerminalPane({ cwd }: { cwd: string | null }) {
  const isMobile = useIsMobile();
  const hasCwd = Boolean(cwd);
  const projectLocked = useAppState((state) =>
    cwd
      ? state.projects.some(
          (p) => p.path === cwd && p.interactionDisabled === true,
        )
      : false,
  );
  const workspace = useAppState((state) =>
    cwd ? (state.projectTerminals[cwd] ?? null) : null,
  );
  const activeTerminalId = workspace?.selectedTerminalId ?? null;
  const [isCreating, setIsCreating] = useState(false);
  const [closingTerminalId, setClosingTerminalId] = useState<string | null>(
    null,
  );
  const [selectingTerminalId, setSelectingTerminalId] = useState<string | null>(
    null,
  );

  const getCurrentSize = useCallback(() => {
    return getTerminalSize();
  }, []);

  useEffect(() => {
    if (!cwd) {
      return;
    }

    if (projectLocked) {
      return;
    }

    // Nothing to revive: terminals are only created on explicit request.
    if (!activeTerminalId) {
      return;
    }

    const { cols, rows } = getCurrentSize();
    void orpc.projectTerminals.ensureWorkspace
      .call({
        cwd,
        cols,
        rows,
      })
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        toast.error(`Failed to open project terminal: ${message}`);
      });
  }, [activeTerminalId, cwd, getCurrentSize, projectLocked]);

  const handleCreateTerminal = useCallback(async () => {
    if (!cwd || projectLocked) {
      return;
    }

    setIsCreating(true);
    try {
      const { cols, rows } = getCurrentSize();
      await orpc.projectTerminals.createTerminal.call({
        cwd,
        cols,
        rows,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to create terminal: ${message}`);
    } finally {
      setIsCreating(false);
    }
  }, [cwd, getCurrentSize, projectLocked]);

  const handleRunCommand = useCallback(
    async (commandId: string) => {
      if (!cwd || projectLocked) {
        return;
      }

      setIsCreating(true);
      try {
        const { cols, rows } = getCurrentSize();
        await orpc.projectTerminals.runCommand.call({
          cwd,
          commandId,
          cols,
          rows,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        toast.error(`Failed to run command: ${message}`);
      } finally {
        setIsCreating(false);
      }
    },
    [cwd, getCurrentSize, projectLocked],
  );

  const handleRerunCommand = useCallback(
    async (terminalId: string) => {
      if (!cwd || projectLocked) {
        return;
      }

      try {
        const { cols, rows } = getCurrentSize();
        await orpc.projectTerminals.rerunCommand.call({
          cwd,
          terminalId,
          cols,
          rows,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        toast.error(`Failed to restart command: ${message}`);
      }
    },
    [cwd, getCurrentSize, projectLocked],
  );

  const handleSelectTerminal = useCallback(
    async (terminalId: string) => {
      if (!cwd || projectLocked) {
        return;
      }

      if (terminalId === activeTerminalId) {
        return;
      }

      setSelectingTerminalId(terminalId);
      try {
        await orpc.projectTerminals.selectTerminal.call({
          cwd,
          terminalId,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        toast.error(`Failed to switch terminal: ${message}`);
      } finally {
        setSelectingTerminalId((current) =>
          current === terminalId ? null : current,
        );
      }
    },
    [activeTerminalId, cwd, projectLocked],
  );

  const handleCloseTerminal = useCallback(
    async (terminalId: string) => {
      if (!cwd || projectLocked) {
        return;
      }

      setClosingTerminalId(terminalId);
      try {
        await orpc.projectTerminals.closeTerminal.call({
          cwd,
          terminalId,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        toast.error(`Failed to close terminal: ${message}`);
      } finally {
        setClosingTerminalId((current) =>
          current === terminalId ? null : current,
        );
      }
    },
    [cwd, projectLocked],
  );

  const renderTerminalStack = () => (
    <ProjectTerminalStack
      hasCwd={hasCwd}
      workspace={workspace}
      activeTerminalId={activeTerminalId}
      projectLocked={projectLocked}
      isCreating={isCreating}
      onCreateTerminal={() => {
        void handleCreateTerminal();
      }}
    />
  );

  if (isMobile) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {hasCwd ? (
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/70 px-2 py-1">
            {workspace?.order.map((terminalId) => {
              const terminal = workspace.terminals[terminalId];
              if (!terminal) {
                return null;
              }

              const isActive = terminalId === activeTerminalId;
              const isClosing = closingTerminalId === terminalId;
              const isSelecting = selectingTerminalId === terminalId;
              const statusMeta = getTerminalStatusMeta(
                isClosing ? "stopping" : terminal.status,
              );
              const StatusIcon = statusMeta.icon;

              return (
                <div
                  key={terminalId}
                  className={cn(
                    "flex min-h-9 shrink-0 overflow-hidden rounded-md text-sm transition",
                    isActive
                      ? "bg-white/15 text-white"
                      : "text-zinc-400 hover:bg-white/8 hover:text-zinc-200",
                  )}
                >
                  <button
                    type="button"
                    className="flex min-h-9 items-center gap-1.5 px-2 text-left"
                    onClick={() => {
                      void handleSelectTerminal(terminalId);
                    }}
                    disabled={projectLocked || isClosing || isSelecting}
                  >
                    <StatusIcon
                      role="img"
                      aria-label={statusMeta.label}
                      className={cn(
                        "size-3 shrink-0",
                        statusMeta.className,
                        statusMeta.animate && "motion-safe:animate-spin",
                      )}
                    />
                    <span className="max-w-32 truncate text-xs">
                      {terminal.title}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="flex min-h-9 w-8 shrink-0 items-center justify-center text-zinc-300 hover:bg-white/10 hover:text-white"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleCloseTerminal(terminalId);
                    }}
                    disabled={projectLocked || isClosing}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
            <Button
              variant="flat"
              className="h-9 w-9 shrink-0 px-0"
              onClick={() => {
                void handleCreateTerminal();
              }}
              disabled={isCreating || projectLocked}
            >
              <Plus className="size-3.5" />
            </Button>
            {cwd ? (
              <ProjectCommandsMenu
                cwd={cwd}
                disabled={isCreating || projectLocked}
                triggerClassName="h-9 w-7 shrink-0 px-0"
                onRun={(commandId) => {
                  void handleRunCommand(commandId);
                }}
              />
            ) : null}
          </div>
        ) : null}

        <div className="min-h-0 flex-1">{renderTerminalStack()}</div>
        {activeTerminalId ? (
          <TerminalKeyBar terminalId={activeTerminalId} />
        ) : null}
      </div>
    );
  }

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full min-h-0">
      <ResizablePanel defaultSize="80" minSize="40">
        {renderTerminalStack()}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize="20" minSize="12" maxSize="40">
        <aside className="flex h-full flex-col border-l border-border/70 bg-black/15">
          <div className="flex h-7 border-b border-border/70">
            <div className="flex flex-1 items-center gap-1.5 px-2">
              <TerminalSquare className="size-3.5 text-muted-foreground" />
              <span className="truncate text-xs font-medium">
                Project Terminals
              </span>
            </div>
            {cwd ? (
              <>
                <Button
                  variant="flat"
                  className="h-full w-7 shrink-0 px-0"
                  onClick={() => {
                    void handleCreateTerminal();
                  }}
                  disabled={isCreating || projectLocked}
                >
                  <Plus className="size-3.5" />
                </Button>
                <ProjectCommandsMenu
                  cwd={cwd}
                  disabled={isCreating || projectLocked}
                  triggerClassName="h-full w-6 shrink-0 px-0"
                  onRun={(commandId) => {
                    void handleRunCommand(commandId);
                  }}
                />
              </>
            ) : null}
          </div>

          {!hasCwd ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center">
              <div className="space-y-2 text-xs text-zinc-500">
                <p>No active session</p>
                <p>Project terminals appear here for the selected session.</p>
              </div>
            </div>
          ) : workspace?.order.length ? (
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {workspace.order.map((terminalId) => {
                const terminal = workspace.terminals[terminalId];
                if (!terminal) {
                  return null;
                }

                const isActive = terminalId === activeTerminalId;
                const isClosing = closingTerminalId === terminalId;
                const isSelecting = selectingTerminalId === terminalId;
                const statusMeta = getTerminalStatusMeta(
                  isClosing ? "stopping" : terminal.status,
                );
                const StatusIcon = statusMeta.icon;

                return (
                  <li key={terminalId} className="group/terminal relative">
                    <button
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-1.5 px-1.5 py-1 text-left text-sm transition pointer-coarse:py-2",
                        terminal.commandId ? "pr-14" : "pr-7",
                        isActive
                          ? "bg-white/12 text-white"
                          : "text-zinc-400 hover:bg-white/8 hover:text-zinc-200",
                      )}
                      onClick={() => {
                        void handleSelectTerminal(terminalId);
                      }}
                      disabled={projectLocked || isClosing || isSelecting}
                    >
                      <StatusIcon
                        role="img"
                        aria-label={statusMeta.label}
                        className={cn(
                          "size-3 shrink-0",
                          statusMeta.className,
                          statusMeta.animate && "motion-safe:animate-spin",
                        )}
                      />
                      <span className="truncate text-xs">{terminal.title}</span>
                    </button>
                    {terminal.commandId ? (
                      <Button
                        variant="flat"
                        className="absolute inset-y-0 right-7 h-full w-7 px-0 opacity-0 group-hover/terminal:opacity-100 pointer-coarse:opacity-100"
                        disabled={projectLocked || isClosing}
                        aria-label={`Run ${terminal.title} again`}
                        onClick={() => {
                          void handleRerunCommand(terminalId);
                        }}
                      >
                        <RotateCw className="size-3" />
                      </Button>
                    ) : null}
                    <Button
                      variant="flat"
                      className="absolute inset-y-0 right-0 h-full w-7 px-0 opacity-0 group-hover/terminal:opacity-100 pointer-coarse:opacity-100"
                      disabled={projectLocked || isClosing}
                      onClick={() => {
                        void handleCloseTerminal(terminalId);
                      }}
                    >
                      <X className="size-3" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center">
              <div className="space-y-2 text-xs text-zinc-500">
                <p>No project terminals</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void handleCreateTerminal();
                  }}
                  disabled={isCreating || projectLocked}
                >
                  Create terminal
                </Button>
              </div>
            </div>
          )}
        </aside>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
