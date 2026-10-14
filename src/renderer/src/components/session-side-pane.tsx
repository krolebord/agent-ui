import type { Artifact } from "@main/artifacts-service";
import type { ScheduledPrompt } from "@main/scheduled-prompts/state";
import type { Session } from "@main/sessions/state";
import { useMainViewStore } from "@renderer/hooks/use-main-view";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import { formatRelativeTime } from "@renderer/services/terminal-session-selectors";
import {
  describePromptSchedule,
  supportsScheduledPrompts,
} from "@shared/scheduled-prompts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CalendarClock,
  Clock,
  Download,
  LoaderCircle,
  PackageOpen,
  PanelRight,
  Plus,
  Send,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { combine, persist } from "zustand/middleware";
import {
  ArtifactIcon,
  canPreviewArtifact,
  downloadArtifact,
  formatBytes,
  useArtifactPreviewDialogStore,
} from "./artifacts-page";
import {
  ScheduledPromptComposer,
  ScheduledPromptText,
  useScheduledPromptComposerStore,
} from "./scheduled-prompt-composer";
import { SidebarIconButton } from "./session-sidebar-item";
import { useAppState } from "./sync-state-provider";
import { Button } from "./ui/button";

export const SESSION_SIDE_PANE_ID = "session-side-pane";

export const useSessionSidePaneStore = create(
  persist(
    combine(
      {
        open: true,
        size: "22" as number | string,
      },
      (set) => ({
        toggle: () => {
          set((state) => ({ open: !state.open }));
        },
        show: () => {
          set({ open: true });
        },
        setSize: (size: number | string) => {
          set({ size });
        },
      }),
    ),
    {
      name: "agent-ui:sessionSidePane",
    },
  ),
);

function useSessionArtifacts(sessionId: string): Artifact[] {
  const artifacts = useAppState((state) => state.artifacts);
  return Object.values(artifacts)
    .filter((artifact) => artifact.sessionId === sessionId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function useSessionScheduledPrompts(sessionId: string): ScheduledPrompt[] {
  const entries = useAppState((state) => state.scheduledPrompts);
  return Object.values(entries)
    .filter((entry) => entry.sessionId === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function SessionSidePaneToggle({ session }: { session: Session }) {
  const open = useSessionSidePaneStore((state) => state.open);
  const toggle = useSessionSidePaneStore((state) => state.toggle);
  const artifactCount = useSessionArtifacts(session.sessionId).length;
  const label = open ? "Hide session sidebar" : "Show session sidebar";

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(
        "h-7 shrink-0 gap-1.5 px-1.5 max-md:hidden",
        open && "bg-accent",
      )}
      onClick={toggle}
      aria-label={label}
      aria-pressed={open}
      title={label}
    >
      {!open && artifactCount > 0 ? (
        <span className="flex items-center gap-0.5 text-muted-foreground">
          <PackageOpen className="size-3.5" />
          <span className="font-mono text-[11px]">{artifactCount}</span>
        </span>
      ) : null}
      <PanelRight
        className={cn(
          "size-3.5",
          open ? "text-foreground" : "text-muted-foreground",
        )}
      />
    </Button>
  );
}

export function SessionSidePane({ session }: { session: Session }) {
  const projectLocked = useAppState((state) =>
    state.projects.some(
      (project) =>
        project.path === session.startupConfig.cwd &&
        project.interactionDisabled === true,
    ),
  );

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-y-auto border-l border-border/70 bg-black/15">
      {supportsScheduledPrompts(session) ? (
        <ScheduledPromptsSection session={session} disabled={projectLocked} />
      ) : null}
      <ArtifactsSection sessionId={session.sessionId} />
    </aside>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: typeof PanelRight;
  title: string;
  count: number;
  children?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-10 flex h-7 shrink-0 border-b border-border/70 bg-background/95">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium">{title}</span>
        {count > 0 ? (
          <span className="font-mono text-[11px] text-muted-foreground">
            {count}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function ScheduledPromptsSection({
  session,
  disabled,
}: {
  session: Session;
  disabled: boolean;
}) {
  const prompts = useSessionScheduledPrompts(session.sessionId);
  const target = useScheduledPromptComposerStore((state) =>
    state.target?.sessionId === session.sessionId ? state.target : null,
  );
  const openComposer = useScheduledPromptComposerStore((state) => state.open);
  const closeComposer = useScheduledPromptComposerStore((state) => state.close);
  const creating = target !== null && target.entryId === null;
  const remove = useMutation({
    mutationFn: (id: string) => orpc.scheduledPrompts.delete.call({ id }),
    onSuccess: (_data, id) => {
      if (target?.entryId === id) closeComposer();
    },
    onError: (err) => toast.error(err.message),
  });
  const send = useMutation({
    mutationFn: (id: string) => orpc.scheduledPrompts.sendNow.call({ id }),
    onSuccess: (_data, id) => {
      if (target?.entryId === id) closeComposer();
      toast.success("Prompt queued for the next available turn");
    },
    onError: (err) => toast.error(err.message),
  });
  const busy = disabled || remove.isPending || send.isPending;

  return (
    <section aria-label="Scheduled prompts" className="shrink-0">
      <SectionHeader
        icon={CalendarClock}
        title="Scheduled prompts"
        count={prompts.length}
      >
        <Button
          variant="flat"
          className={cn("h-full w-7 shrink-0 px-0", creating && "bg-accent")}
          disabled={disabled}
          aria-label="Schedule prompt"
          aria-pressed={creating}
          title="Schedule prompt"
          onClick={() =>
            creating ? closeComposer() : openComposer(session.sessionId)
          }
        >
          <Plus className="size-3.5" />
        </Button>
      </SectionHeader>
      {creating ? (
        <div className="border-b border-border/70 p-2">
          <ScheduledPromptComposer
            key={target.nonce}
            session={session}
            entry={null}
            disabled={disabled}
            onDone={closeComposer}
          />
        </div>
      ) : null}
      {prompts.length ? (
        <ul>
          {prompts.map((entry) =>
            target?.entryId === entry.id ? (
              <li
                key={entry.id}
                className="border-l-2 border-primary bg-primary/5 p-2"
              >
                <ScheduledPromptComposer
                  key={target.nonce}
                  session={session}
                  entry={entry}
                  disabled={disabled}
                  onDone={closeComposer}
                />
              </li>
            ) : (
              <ScheduledPromptRow
                key={entry.id}
                entry={entry}
                disabled={busy}
                onEdit={() => openComposer(session.sessionId, entry.id)}
                onCancel={() => remove.mutate(entry.id)}
                onSend={() => send.mutate(entry.id)}
              />
            ),
          )}
        </ul>
      ) : creating ? null : (
        <p className="px-2 py-2 text-xs text-muted-foreground">
          No scheduled prompts
        </p>
      )}
    </section>
  );
}

export function SchedulePromptButton({
  session,
  disabled,
}: {
  session: Session;
  disabled?: boolean;
}) {
  const count = useSessionScheduledPrompts(session.sessionId).length;
  const openComposer = useScheduledPromptComposerStore((state) => state.open);
  const showSidePane = useSessionSidePaneStore((state) => state.show);
  if (!supportsScheduledPrompts(session)) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      className={cn("h-7 shrink-0 gap-1 px-1.5", count > 0 && "text-primary")}
      aria-label={
        count ? `Scheduled prompts, ${count} pending` : "Schedule prompt"
      }
      title={count ? `Scheduled prompts (${count})` : "Schedule prompt"}
      onClick={() => {
        showSidePane();
        openComposer(session.sessionId);
      }}
    >
      <CalendarClock className="size-3.5" />
      {count > 0 ? (
        <span className="font-mono text-[11px]">{count}</span>
      ) : null}
    </Button>
  );
}

function ScheduledPromptRow({
  entry,
  disabled,
  onEdit,
  onCancel,
  onSend,
}: {
  entry: ScheduledPrompt;
  disabled: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSend: () => void;
}) {
  const isSending = entry.status === "sending";
  const isProblem = entry.status === "failed" || entry.status === "uncertain";
  const StatusIcon = isSending ? LoaderCircle : isProblem ? AlertCircle : Clock;

  return (
    <li className="group/prompt relative">
      <button
        type="button"
        className={cn(
          "flex w-full items-start gap-1.5 px-2 py-1.5 text-left transition hover:bg-white/8 pointer-coarse:py-2",
          !isSending && "pr-16",
        )}
        disabled={disabled || isSending}
        onClick={onEdit}
        title="Edit scheduled prompt"
      >
        <StatusIcon
          className={cn(
            "mt-0.5 size-3 shrink-0",
            isProblem ? "text-rose-400" : "text-muted-foreground",
            isSending && "motion-safe:animate-spin",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-xs break-words whitespace-pre-wrap text-zinc-200">
            <ScheduledPromptText prompt={entry.prompt} />
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {isSending ? "Sending…" : describePromptSchedule(entry.schedule)}
          </span>
          {entry.message ? (
            <span
              className={cn(
                "mt-0.5 block line-clamp-2 text-[11px]",
                isProblem ? "text-rose-400" : "text-muted-foreground",
              )}
            >
              {entry.message}
            </span>
          ) : null}
        </span>
      </button>
      {!isSending ? (
        <div className="absolute top-1 right-1 flex opacity-0 group-hover/prompt:opacity-100 group-focus-within/prompt:opacity-100 pointer-coarse:opacity-100">
          <Button
            variant="flat"
            className="size-6 px-0"
            disabled={disabled}
            aria-label="Send now"
            title="Send now"
            onClick={onSend}
          >
            <Send className="size-3" />
          </Button>
          <Button
            variant="flat"
            className="size-6 px-0"
            disabled={disabled}
            aria-label="Cancel scheduled prompt"
            title="Cancel"
            onClick={onCancel}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function ArtifactsSection({ sessionId }: { sessionId: string }) {
  const artifacts = useSessionArtifacts(sessionId);
  const showArtifacts = useMainViewStore((state) => state.showArtifacts);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <section aria-label="Artifacts" className="shrink-0">
      <SectionHeader
        icon={PackageOpen}
        title="Artifacts"
        count={artifacts.length}
      >
        {artifacts.length ? (
          <Button
            variant="flat"
            className="h-full shrink-0 px-2 text-[11px] text-muted-foreground"
            onClick={() => showArtifacts(sessionId)}
          >
            View all
          </Button>
        ) : null}
      </SectionHeader>
      {artifacts.length ? (
        <ul>
          {artifacts.map((artifact) => (
            <ArtifactRow key={artifact.id} artifact={artifact} now={now} />
          ))}
        </ul>
      ) : (
        <p className="px-2 py-2 text-xs text-muted-foreground">
          No artifacts yet
        </p>
      )}
    </section>
  );
}

function ArtifactRow({ artifact, now }: { artifact: Artifact; now: number }) {
  const [downloading, setDownloading] = useState(false);
  const openPreview = useArtifactPreviewDialogStore((state) => state.open);
  const queryClient = useQueryClient();
  const previewable = canPreviewArtifact(artifact);
  const download = async () => {
    setDownloading(true);
    await downloadArtifact(artifact);
    setDownloading(false);
  };
  const prefetchPreview = () => {
    if (!previewable) return;
    void queryClient.prefetchQuery({
      ...orpc.artifacts.getDownloadUrl.queryOptions({
        input: { id: artifact.id },
      }),
      staleTime: Number.POSITIVE_INFINITY,
    });
  };

  return (
    <li className="group/artifact relative">
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-1.5 py-1 pr-16 pl-2 text-left transition hover:bg-white/8 pointer-coarse:py-2 pointer-coarse:pr-20",
          !artifact.available && "opacity-50",
        )}
        disabled={!artifact.available || downloading}
        onPointerEnter={prefetchPreview}
        onFocus={prefetchPreview}
        onClick={() => {
          if (previewable) openPreview(artifact.id);
          else void download();
        }}
        title={artifact.description ?? artifact.name}
      >
        <ArtifactIcon
          artifact={artifact}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">
          {artifact.name}
        </span>
      </button>
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center transition group-hover/artifact:opacity-0 group-focus-within/artifact:opacity-0 pointer-coarse:opacity-0">
        <time
          dateTime={new Date(artifact.createdAt).toISOString()}
          className="text-xs tabular-nums text-zinc-400"
        >
          {formatRelativeTime(artifact.createdAt, now)}
        </time>
      </span>
      <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-1 opacity-0 transition group-hover/artifact:opacity-100 group-focus-within/artifact:opacity-100 pointer-coarse:opacity-100">
        <span className="font-mono text-[10px] text-muted-foreground">
          {artifact.available ? formatBytes(artifact.size) : "missing"}
        </span>
        <SidebarIconButton
          icon={Download}
          label={`Download ${artifact.name}`}
          disabled={!artifact.available || downloading}
          onClick={() => void download()}
        />
      </div>
    </li>
  );
}
