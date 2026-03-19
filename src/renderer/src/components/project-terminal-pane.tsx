import { consumeEventIterator } from "@orpc/client";
import {
  TerminalPane,
  type TerminalPaneHandle,
} from "@renderer/components/terminal-pane";
import { Button } from "@renderer/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@renderer/components/ui/resizable";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import {
  AlertCircle,
  CircleDot,
  LoaderCircle,
  Plus,
  TerminalSquare,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAppState } from "./sync-state-provider";

function getTerminalStatusMeta(status: string) {
  switch (status) {
    case "starting":
    case "running":
    case "stopping":
      return {
        icon: LoaderCircle,
        className: "text-zinc-400",
        animate: true,
      };
    case "error":
      return {
        icon: AlertCircle,
        className: "text-rose-400",
      };
    case "stopped":
      return {
        icon: CircleDot,
        className: "text-zinc-600",
      };
    default:
      return {
        icon: CircleDot,
        className: "text-emerald-400",
      };
  }
}

export function ProjectTerminalPane({ cwd }: { cwd: string | null }) {
  const hasCwd = Boolean(cwd);
  const workspace = useAppState((state) =>
    cwd ? (state.projectTerminals[cwd] ?? null) : null,
  );
  const hasWorkspace = workspace !== null;
  const activeTerminalId = workspace?.selectedTerminalId ?? null;
  const activeTerminal =
    activeTerminalId && workspace
      ? (workspace.terminals[activeTerminalId] ?? null)
      : null;

  const activeTerminalRef = useRef(activeTerminal);
  const terminalRef = useRef<TerminalPaneHandle | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [closingTerminalId, setClosingTerminalId] = useState<string | null>(
    null,
  );
  const [selectingTerminalId, setSelectingTerminalId] = useState<string | null>(
    null,
  );

  const getCurrentSize = useCallback(() => {
    return terminalRef.current?.getSize() ?? { cols: 80, rows: 24 };
  }, []);

  useEffect(() => {
    activeTerminalRef.current = activeTerminal;
  }, [activeTerminal]);

  useEffect(() => {
    if (!cwd) {
      return;
    }

    if (hasWorkspace && !activeTerminalId) {
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
  }, [activeTerminalId, cwd, getCurrentSize, hasWorkspace]);

  useEffect(() => {
    const currentTerminal = activeTerminalRef.current;
    if (!activeTerminalId || !currentTerminal) {
      terminalRef.current?.clear();
      return;
    }

    terminalRef.current?.clear();
    terminalRef.current?.write(currentTerminal.bufferedOutput ?? "");
    terminalRef.current?.autofit();

    const cancel = consumeEventIterator(
      orpc.projectTerminals.subscribeToTerminal
        .call({ terminalId: activeTerminalId })
        .then((stream) => {
          terminalRef.current?.focus();
          return stream;
        }),
      {
        onEvent(event) {
          switch (event.type) {
            case "data":
              terminalRef.current?.write(event.data);
              break;
            case "clear":
              terminalRef.current?.clear();
              break;
          }
        },
        onError(error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          if (message.includes("closed or aborted")) {
            return;
          }
          toast.error(`Project terminal disconnected: ${message}`);
        },
      },
    );

    return () => void cancel();
  }, [activeTerminalId]);

  const handleTerminalInput = useCallback(
    (data: string) => {
      if (!activeTerminalId) {
        return;
      }

      void orpc.projectTerminals.writeToTerminal.call({
        terminalId: activeTerminalId,
        data,
      });
    },
    [activeTerminalId],
  );

  const handleTerminalResize = useCallback(
    (cols: number, rows: number) => {
      if (!activeTerminalId) {
        return;
      }

      void orpc.projectTerminals.resizeTerminal.call({
        terminalId: activeTerminalId,
        cols,
        rows,
      });
    },
    [activeTerminalId],
  );

  const handleCreateTerminal = useCallback(async () => {
    if (!cwd) {
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
  }, [cwd, getCurrentSize]);

  const handleSelectTerminal = useCallback(
    async (terminalId: string) => {
      if (!cwd) {
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
    [activeTerminalId, cwd],
  );

  const handleCloseTerminal = useCallback(
    async (terminalId: string) => {
      if (!cwd) {
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
    [cwd],
  );

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full min-h-0">
      <ResizablePanel defaultSize="80" minSize="40">
        <div className="h-full min-w-0 bg-black/10">
          {!hasCwd ? (
            <div className="flex h-full items-center justify-center p-6">
              <div className="max-w-xs space-y-2 text-center">
                <p className="text-sm text-zinc-300">
                  Select a session to view project terminals.
                </p>
                <p className="text-xs text-zinc-500">
                  The terminal and project pane layout stays available here,
                  even when no session is selected.
                </p>
              </div>
            </div>
          ) : activeTerminal ? (
            <TerminalPane
              ref={terminalRef}
              onInput={handleTerminalInput}
              onResize={handleTerminalResize}
              trackGlobalSize={false}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6">
              <div className="max-w-xs space-y-3 text-center">
                <p className="text-sm text-zinc-300">
                  No terminal selected for this project.
                </p>
                <Button
                  variant="outline"
                  onClick={() => {
                    void handleCreateTerminal();
                  }}
                  disabled={isCreating}
                >
                  Create terminal
                </Button>
              </div>
            </div>
          )}
        </div>
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
            {hasCwd ? (
              <Button
                variant="flat"
                className="h-full w-9 shrink-0 px-0"
                onClick={() => {
                  void handleCreateTerminal();
                }}
                disabled={isCreating}
              >
                <Plus className="size-3.5" />
              </Button>
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

                const statusMeta = getTerminalStatusMeta(terminal.status);
                const StatusIcon = statusMeta.icon;
                const isActive = terminalId === activeTerminalId;
                const isClosing = closingTerminalId === terminalId;
                const isSelecting = selectingTerminalId === terminalId;

                return (
                  <li key={terminalId} className="group/terminal relative">
                    <button
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-1.5 px-1.5 py-1 pr-7 text-left text-sm transition",
                        isActive
                          ? "bg-white/12 text-white"
                          : "text-zinc-400 hover:bg-white/8 hover:text-zinc-200",
                      )}
                      onClick={() => {
                        void handleSelectTerminal(terminalId);
                      }}
                      disabled={isClosing || isSelecting}
                    >
                      <StatusIcon
                        className={cn(
                          "size-3 shrink-0",
                          statusMeta.className,
                          statusMeta.animate && "animate-spin",
                        )}
                      />
                      <span className="truncate text-xs">{terminal.title}</span>
                    </button>
                    <Button
                      variant="flat"
                      className="absolute inset-y-0 right-0 h-full w-7 px-0 opacity-0 group-hover/terminal:opacity-100"
                      disabled={isClosing}
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
                  disabled={isCreating}
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
