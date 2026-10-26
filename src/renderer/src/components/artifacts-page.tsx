import type { Artifact, ArtifactLocation } from "@main/artifacts-service";
import {
  File as CodeFile,
  EditProvider,
  type FileOptions,
} from "@pierre/diffs/react";
import { MobileSidebarTrigger } from "@renderer/components/mobile-sidebar-trigger";
import { useAppState } from "@renderer/components/sync-state-provider";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@renderer/components/ui/toggle-group";
import { useDiffsEditorFactory } from "@renderer/hooks/use-diffs-editor-factory";
import { useMainViewStore } from "@renderer/hooks/use-main-view";
import {
  type CleanupMark,
  canDeleteArtifactFile,
  describeApplyResult,
  describeCleanupAction,
  describeCleanupResult,
  nextCleanupMark,
} from "@renderer/lib/artifact-cleanup";
import {
  type ArtifactPreviewKind,
  canEditArtifact,
  formatTextPreview,
  getArtifactPreviewKind,
  getHtmlPreviewSandbox,
  getTextPreviewFile,
  getVisualFrameHeight,
  hasArtifactSourceView,
  MAX_TEXT_PREVIEW_BYTES,
  readTextPreview,
} from "@renderer/lib/artifact-preview";
import { hasNativeDesktopShell } from "@renderer/lib/native-shell";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import {
  getProjectDisplayName,
  getProjectNameFromPath,
} from "@renderer/services/terminal-session-selectors";
import { readVisualContentHeight } from "@shared/visuals";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Archive,
  Copy,
  Download,
  Eraser,
  Eye,
  File,
  FileImage,
  FileText,
  LayoutDashboard,
  LoaderCircle,
  Minus,
  PackageOpen,
  Pencil,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { combine } from "zustand/middleware";
import { useConfirmDialogStore } from "./confirm-dialog";
import { ProjectFavicon } from "./project-favicon";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

function formatCreatedAt(createdAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(createdAt);
}

export function ArtifactIcon({
  artifact,
  className = "size-4",
}: {
  artifact: Artifact;
  className?: string;
}) {
  if (artifact.kind === "visual") {
    return <LayoutDashboard className={className} />;
  }
  if (artifact.mimeType?.startsWith("image/")) {
    return <FileImage className={className} />;
  }
  if (
    artifact.mimeType?.startsWith("text/") ||
    artifact.mimeType === "application/json"
  ) {
    return <FileText className={className} />;
  }
  if (artifact.mimeType === "application/zip") {
    return <Archive className={className} />;
  }
  return <File className={className} />;
}

export function ArtifactsPage() {
  const artifactsById = useAppState((state) => state.artifacts);
  const sessionId = useMainViewStore((state) => state.artifactsSessionId);
  const clearSessionFilter = useMainViewStore(
    (state) => state.clearArtifactsSessionFilter,
  );
  const sessionTitle = useAppState((state) =>
    sessionId ? (state.sessions[sessionId]?.title ?? null) : null,
  );
  const [query, setQuery] = useState("");
  const [bulkMode, setBulkMode] = useState(false);
  const [marks, setMarks] = useState<Map<string, CleanupMark>>(new Map());
  const refreshAvailability = useMutation(
    orpc.artifacts.refreshAvailability.mutationOptions(),
  );
  const { mutate: refresh } = refreshAvailability;
  const refreshedIds = useRef<Set<string>>(new Set());
  const allIds = useMemo(
    () => Object.keys(artifactsById).sort(),
    [artifactsById],
  );
  const locations = useQuery(
    orpc.artifacts.inspect.queryOptions({ input: { ids: allIds } }),
  ).data;

  useEffect(() => {
    const ids = Object.keys(artifactsById);
    const hasNewArtifact = ids.some((id) => !refreshedIds.current.has(id));
    refreshedIds.current = new Set(ids);
    if (hasNewArtifact) refresh(undefined);
  }, [artifactsById, refresh]);

  const cleanup = useMutation({
    mutationFn: () => orpc.artifacts.cleanup.call(),
    onSuccess: (result) => {
      const message = describeCleanupResult(result);
      if (message) toast.success(message);
      setMarks(new Map());
      setBulkMode(true);
    },
    onError: (error) => toast.error(error.message),
  });

  const artifacts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return Object.values(artifactsById)
      .filter((artifact) => {
        if (sessionId && artifact.sessionId !== sessionId) return false;
        if (!normalizedQuery) return true;
        return [artifact.name, artifact.description, artifact.path].some(
          (value) => value?.toLowerCase().includes(normalizedQuery),
        );
      })
      .sort((left, right) =>
        bulkMode ? right.size - left.size : right.createdAt - left.createdAt,
      );
  }, [artifactsById, query, sessionId, bulkMode]);

  const cycleMark = (id: string, keepMarked: boolean) => {
    setMarks((current) => {
      const mark = nextCleanupMark(current.get(id), locations?.[id]);
      if (!mark && keepMarked) return current;
      const next = new Map(current);
      if (mark) next.set(id, mark);
      else next.delete(id);
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/70 px-2 py-1.5">
        <MobileSidebarTrigger className="md:hidden" />
        <PackageOpen className="size-3.5 text-muted-foreground max-md:hidden" />
        <span className="text-sm font-medium">Artifacts</span>
        <Badge variant="secondary" className="ml-1 tabular-nums">
          {sessionId
            ? Object.values(artifactsById).filter(
                (artifact) => artifact.sessionId === sessionId,
              ).length
            : Object.keys(artifactsById).length}
        </Badge>
        <div className="ml-auto">
          {bulkMode ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => {
                setBulkMode(false);
                setMarks(new Map());
              }}
            >
              Done
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1.5"
              disabled={cleanup.isPending || allIds.length === 0}
              title="Remove artifacts whose files are gone and old preview screenshots, then pick what else to delete"
              onClick={() => cleanup.mutate()}
            >
              {cleanup.isPending ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Eraser className="size-3.5" />
              )}
              Clean up
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 md:p-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                {bulkMode
                  ? "Clean up artifacts"
                  : "Files published by your agents"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {bulkMode
                  ? "Largest first. Click a row once to remove it from the list, again to delete its file too. Files tracked by git are never deleted."
                  : "Artifacts stay listed across sessions. Downloads use the file currently at the published path."}
              </p>
            </div>
            <div className="flex w-full flex-col gap-2 md:w-auto md:flex-row md:items-center">
              {sessionId ? (
                <Badge
                  variant="outline"
                  className="h-8 max-w-full gap-1 pr-1 md:max-w-56"
                >
                  <span className="truncate" title={sessionTitle ?? undefined}>
                    Session: {sessionTitle ?? "Deleted session"}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-5 shrink-0 px-0"
                    aria-label="Show artifacts from all sessions"
                    title="Show all sessions"
                    onClick={clearSessionFilter}
                  >
                    <X className="size-3" />
                  </Button>
                </Badge>
              ) : null}
              <div className="relative w-full md:w-64">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter artifacts"
                  aria-label="Filter artifacts"
                  className="h-8 pl-8"
                />
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-md border border-border/60 bg-black/10">
            {artifacts.length === 0 ? (
              <div className="flex min-h-48 flex-col items-center justify-center gap-2 px-6 text-center">
                <PackageOpen className="size-7 text-muted-foreground/60" />
                <p className="text-sm font-medium">
                  {query || sessionId
                    ? "No artifacts match this filter"
                    : "No artifacts yet"}
                </p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  {query
                    ? "Try a file name, description, or remote path."
                    : sessionId
                      ? "This session hasn’t published any artifacts."
                      : "When an agent publishes a file, it will appear here and you’ll get a notification."}
                </p>
              </div>
            ) : bulkMode ? (
              <ul className="divide-y divide-border/40">
                {artifacts.map((artifact) => (
                  <BulkArtifactRow
                    key={artifact.id}
                    artifact={artifact}
                    location={locations?.[artifact.id]}
                    mark={marks.get(artifact.id)}
                    onCycle={(keepMarked) => cycleMark(artifact.id, keepMarked)}
                  />
                ))}
              </ul>
            ) : (
              <ul className="divide-y divide-border/40">
                {artifacts.map((artifact) => (
                  <ArtifactRow
                    key={artifact.id}
                    artifact={artifact}
                    location={locations?.[artifact.id]}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
      {bulkMode ? (
        <CleanupBar
          artifacts={artifacts}
          locations={locations}
          marks={marks}
          onMark={setMarks}
        />
      ) : null}
    </div>
  );
}

function CleanupBar({
  artifacts,
  locations,
  marks,
  onMark,
}: {
  artifacts: Artifact[];
  locations: Record<string, ArtifactLocation> | undefined;
  marks: Map<string, CleanupMark>;
  onMark: Dispatch<SetStateAction<Map<string, CleanupMark>>>;
}) {
  const confirm = useConfirmDialogStore((state) => state.confirm);
  const marked = artifacts.filter((artifact) => marks.has(artifact.id));
  const toDelete = marked.filter(
    (artifact) =>
      marks.get(artifact.id) === "delete" &&
      canDeleteArtifactFile(locations?.[artifact.id]),
  );
  const toRemove = marked.filter((artifact) => !toDelete.includes(artifact));
  const deleteBytes = toDelete.reduce((sum, a) => sum + a.size, 0);
  const outsideProjects = artifacts.filter(
    (artifact) => locations?.[artifact.id]?.kind === "elsewhere",
  );
  const allMarked = artifacts.length > 0 && marked.length === artifacts.length;
  const apply = useMutation({
    mutationFn: async (ids: { remove: string[]; delete: string[] }) => {
      if (ids.remove.length) {
        await orpc.artifacts.removeMany.call({ ids: ids.remove });
      }
      const result = ids.delete.length
        ? await orpc.artifacts.deleteFiles.call({ ids: ids.delete })
        : { deleted: 0, skipped: 0 };
      return { removed: ids.remove.length, ...result };
    },
    onSuccess: (result, ids) => {
      onMark((current) => {
        const next = new Map(current);
        for (const id of [...ids.remove, ...ids.delete]) next.delete(id);
        return next;
      });
      toast.success(describeApplyResult(result));
    },
    onError: (error) => toast.error(error.message),
  });
  const ids = {
    remove: toRemove.map((a) => a.id),
    delete: toDelete.map((a) => a.id),
  };

  return (
    <div className="shrink-0 border-t border-border/70 bg-background/95 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground tabular-nums">
          {marked.length} marked
          {toDelete.length ? ` · ${formatBytes(deleteBytes)} to delete` : ""}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() =>
            onMark((current) =>
              allMarked
                ? new Map()
                : new Map(
                    artifacts.flatMap((a) => {
                      const mark =
                        current.get(a.id) ??
                        nextCleanupMark(undefined, locations?.[a.id]);
                      return mark ? [[a.id, mark] as const] : [];
                    }),
                  ),
            )
          }
        >
          {allMarked ? "Clear selection" : "Select all"}
        </Button>
        {outsideProjects.length ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            title="Mark files outside any project for deletion"
            onClick={() =>
              onMark((current) => {
                const next = new Map(current);
                for (const a of outsideProjects) next.set(a.id, "delete");
                return next;
              })
            }
          >
            Select outside projects
          </Button>
        ) : null}
        <Button
          type="button"
          variant={toDelete.length ? "destructive" : "outline"}
          size="sm"
          className="ml-auto h-7"
          disabled={apply.isPending || marked.length === 0}
          onClick={() => {
            if (!toDelete.length) {
              apply.mutate(ids);
              return;
            }
            confirm({
              title: `Delete ${toDelete.length} file${toDelete.length === 1 ? "" : "s"}?`,
              description: [
                `${formatBytes(deleteBytes)} will be ${hasNativeDesktopShell ? "moved to the Trash" : "permanently deleted"}, and the artifacts removed from the list.`,
                hasNativeDesktopShell &&
                toDelete.some((artifact) => artifact.kind === "visual")
                  ? "Visuals are deleted permanently."
                  : "",
                toRemove.length
                  ? `${toRemove.length} other artifact${toRemove.length === 1 ? "" : "s"} will only be removed from the list.`
                  : "",
              ]
                .filter(Boolean)
                .join(" "),
              confirmLabel: "Delete files",
              onConfirm: async () => {
                await apply.mutateAsync(ids);
              },
            });
          }}
        >
          {apply.isPending ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : null}
          {describeCleanupAction({
            remove: toRemove.length,
            delete: toDelete.length,
          })}
        </Button>
      </div>
    </div>
  );
}

function LocationBadges({
  location,
}: {
  location: ArtifactLocation | undefined;
}) {
  const projectName = useAppState((state) => {
    if (location?.kind !== "project") return null;
    const project = state.projects.find(
      (candidate) => candidate.path === location.projectPath,
    );
    return project
      ? getProjectDisplayName(project)
      : getProjectNameFromPath(location.projectPath);
  });
  if (!location || location.kind === "app") return null;
  return (
    <>
      {location.kind === "project" ? (
        <Badge
          variant="outline"
          className="max-w-40 shrink-0 gap-1 border-sky-400/30 bg-sky-400/10 pl-1.5 font-normal text-sky-200"
          title={location.projectPath}
        >
          <ProjectFavicon
            projectPath={location.projectPath}
            className="size-3"
          />
          <span className="truncate">{projectName}</span>
        </Badge>
      ) : (
        <Badge
          variant="outline"
          className="shrink-0 border-amber-400/30 bg-amber-400/10 font-normal text-amber-200"
          title="Not inside any project"
        >
          Outside projects
        </Badge>
      )}
      {location.kind === "project" && location.tracked ? (
        <Badge
          variant="outline"
          className="shrink-0 font-normal text-muted-foreground"
          title="Tracked by git, so its file can't be deleted from here"
        >
          Tracked
        </Badge>
      ) : null}
    </>
  );
}

function BulkArtifactRow({
  artifact,
  location,
  mark,
  onCycle,
}: {
  artifact: Artifact;
  location: ArtifactLocation | undefined;
  mark: CleanupMark | undefined;
  onCycle: (keepMarked: boolean) => void;
}) {
  const next = nextCleanupMark(mark, location);
  return (
    <li>
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors md:px-4",
          !mark && "hover:bg-white/[0.025]",
          mark === "remove" && "bg-destructive/[0.07] hover:bg-destructive/10",
          mark === "delete" && "bg-destructive/20 hover:bg-destructive/25",
        )}
        title={
          next === "remove"
            ? "Click to remove from the list and keep the file"
            : next === "delete"
              ? "Click to delete the file"
              : "Click to unmark"
        }
        onClick={(event) => onCycle(event.detail > 1)}
      >
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-sm border",
            !mark && "border-input",
            mark === "remove" && "border-destructive/70 text-destructive",
            mark === "delete" &&
              "border-destructive bg-destructive text-destructive-foreground",
          )}
        >
          {mark === "remove" ? <Minus className="size-3" /> : null}
          {mark === "delete" ? <Trash2 className="size-2.5" /> : null}
        </span>
        <ArtifactIcon
          artifact={artifact}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className="truncate text-sm font-medium"
              title={artifact.name}
            >
              {artifact.name}
            </span>
            {artifact.kind === "visual" ? (
              <Badge variant="secondary" className="shrink-0">
                Visual
              </Badge>
            ) : null}
            {!artifact.available ? (
              <Badge variant="destructive" className="shrink-0">
                Missing
              </Badge>
            ) : null}
            <LocationBadges location={location} />
          </span>
          <span
            className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground/80"
            title={artifact.path}
          >
            {artifact.path}
          </span>
        </span>
        {mark ? (
          <span
            className={cn(
              "shrink-0 text-xs font-medium",
              mark === "delete" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {mark === "delete" ? "Delete file" : "Remove"}
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {formatBytes(artifact.size)}
        </span>
      </button>
    </li>
  );
}

function resolveArtifactHref(destination: { path: string; url: string }) {
  return navigator.userAgent.includes("Electron")
    ? destination.url
    : destination.path;
}

export async function downloadArtifact(artifact: Artifact) {
  try {
    const destination = await orpc.artifacts.getDownloadUrl.call({
      id: artifact.id,
    });
    const anchor = document.createElement("a");
    anchor.href = resolveArtifactHref(destination);
    anchor.download = artifact.name;
    if (navigator.userAgent.includes("Electron")) anchor.target = "_blank";
    anchor.click();
  } catch (error) {
    toast.error(
      error instanceof Error ? error.message : "Failed to download artifact",
    );
  }
}

function ArtifactRow({
  artifact,
  location,
}: {
  artifact: Artifact;
  location: ArtifactLocation | undefined;
}) {
  const [downloading, setDownloading] = useState(false);
  const previewKind = getArtifactPreviewKind(artifact.mimeType);
  const openPreview = useArtifactPreviewDialogStore((state) => state.open);
  const removeArtifact = useMutation(
    orpc.artifacts.remove.mutationOptions({
      onSuccess: () => toast.success("Artifact removed"),
    }),
  );

  const download = async () => {
    setDownloading(true);
    try {
      await downloadArtifact(artifact);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <li className="group relative grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-3 transition-colors hover:bg-white/[0.025] md:px-4">
      <div className="flex min-w-0 gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded border border-border/60 bg-muted/30 text-muted-foreground">
          <ArtifactIcon artifact={artifact} />
        </div>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="truncate text-sm font-medium"
              title={artifact.name}
            >
              {artifact.name}
            </span>
            {artifact.kind === "visual" ? (
              <Badge variant="secondary" className="shrink-0">
                Visual
              </Badge>
            ) : null}
            {!artifact.available ? (
              <Badge variant="destructive" className="shrink-0">
                Missing
              </Badge>
            ) : null}
            <LocationBadges location={location} />
          </div>
          {artifact.description ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {artifact.description}
            </p>
          ) : null}
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground/80">
            <span>{formatBytes(artifact.size)}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={new Date(artifact.createdAt).toISOString()}>
              {formatCreatedAt(artifact.createdAt)}
            </time>
            <span aria-hidden="true">·</span>
            <span
              className="max-w-full truncate font-mono"
              title={artifact.path}
            >
              {artifact.path}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-1">
        {previewKind ? (
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            disabled={!artifact.available}
            onClick={() => openPreview(artifact.id)}
          >
            <Eye className="size-3.5" />
            <span className="max-sm:hidden">Preview</span>
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          disabled={!artifact.available || downloading}
          onClick={() => void download()}
        >
          <Download className="size-3.5" />
          <span className="max-sm:hidden">Download</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="size-8 px-0"
          aria-label={`Copy path for ${artifact.name}`}
          title="Copy remote path"
          onClick={() => {
            void navigator.clipboard.writeText(artifact.path).then(() => {
              toast.success("Artifact path copied");
            });
          }}
        >
          <Copy className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="size-8 px-0 text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${artifact.name}`}
          title="Remove from artifacts"
          disabled={removeArtifact.isPending}
          onClick={() => removeArtifact.mutate({ id: artifact.id })}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}

function confirmDiscardEdits(onConfirm: () => void) {
  useConfirmDialogStore.getState().confirm({
    title: "Discard unsaved edits?",
    description: "Your changes to this artifact haven't been saved.",
    confirmLabel: "Discard",
    onConfirm,
  });
}

export const useArtifactPreviewDialogStore = create(
  combine(
    {
      isOpen: false,
      artifactId: null as string | null,
      editing: false,
      editDirty: false,
    },
    (set, get) => {
      const leaveEditing = (then: () => void) => {
        if (get().editDirty) confirmDiscardEdits(then);
        else then();
      };
      return {
        open: (artifactId: string) => {
          const state = get();
          if (state.isOpen && state.artifactId === artifactId) return;
          leaveEditing(() =>
            set({ isOpen: true, artifactId, editing: false, editDirty: false }),
          );
        },
        close: () => {
          leaveEditing(() =>
            set({ isOpen: false, editing: false, editDirty: false }),
          );
        },
        startEditing: () => {
          set({ editing: true, editDirty: false });
        },
        stopEditing: () => {
          leaveEditing(() => set({ editing: false, editDirty: false }));
        },
        setEditDirty: (editDirty: boolean) => {
          set({ editDirty });
        },
      };
    },
  ),
);

export function canPreviewArtifact(artifact: Artifact): boolean {
  return (
    artifact.available && getArtifactPreviewKind(artifact.mimeType) !== null
  );
}

export function ArtifactPreviewDialog() {
  const isOpen = useArtifactPreviewDialogStore((state) => state.isOpen);
  const artifactId = useArtifactPreviewDialogStore((state) => state.artifactId);
  const close = useArtifactPreviewDialogStore((state) => state.close);
  const editing = useArtifactPreviewDialogStore((state) => state.editing);
  const startEditing = useArtifactPreviewDialogStore(
    (state) => state.startEditing,
  );
  const artifact = useAppState((state) =>
    artifactId ? (state.artifacts[artifactId] ?? null) : null,
  );
  const kind = artifact ? getArtifactPreviewKind(artifact.mimeType) : null;
  const [downloading, setDownloading] = useState(false);

  return (
    <Dialog
      open={isOpen && artifact !== null && kind !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {artifact && kind ? (
        <DialogContent className="flex flex-col sm:max-w-4xl">
          <DialogHeader className="min-w-0 pr-6">
            <DialogTitle className="truncate" title={artifact.name}>
              {artifact.name}
            </DialogTitle>
            <DialogDescription>
              {formatBytes(artifact.size)}
              {artifact.mimeType ? ` · ${artifact.mimeType}` : null}
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <ArtifactEditor key={artifact.id} artifact={artifact} />
          ) : (
            <>
              <ArtifactPreview
                key={artifact.id}
                artifact={artifact}
                kind={kind}
              />
              <DialogFooter>
                {canEditArtifact(artifact, kind) ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5"
                    onClick={startEditing}
                  >
                    <Pencil className="size-3.5" />
                    Edit
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5"
                  disabled={!artifact.available || downloading}
                  onClick={async () => {
                    setDownloading(true);
                    await downloadArtifact(artifact);
                    setDownloading(false);
                  }}
                >
                  <Download className="size-3.5" />
                  Download
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

const TEXT_PREVIEW_OPTIONS = {
  theme: "github-dark-default",
  overflow: "wrap",
  disableFileHeader: true,
} as const satisfies FileOptions<undefined, undefined>;

const TEXT_EDIT_OPTIONS = {
  ...TEXT_PREVIEW_OPTIONS,
  overflow: "scroll",
} as const satisfies FileOptions<undefined, undefined>;

type ArtifactEditDraft = {
  key: number;
  revision: string;
  loadedContents: string;
  savedContents: string;
  contents: string;
  conflict: boolean;
};

let artifactEditSequence = 0;

function createEditDraft(snapshot: {
  contents: string;
  revision: string;
}): ArtifactEditDraft {
  return {
    key: ++artifactEditSequence,
    revision: snapshot.revision,
    loadedContents: snapshot.contents,
    savedContents: snapshot.contents,
    contents: snapshot.contents,
    conflict: false,
  };
}

function ArtifactEditor({ artifact }: { artifact: Artifact }) {
  const stopEditing = useArtifactPreviewDialogStore(
    (state) => state.stopEditing,
  );
  const setEditDirty = useArtifactPreviewDialogStore(
    (state) => state.setEditDirty,
  );
  const confirm = useConfirmDialogStore((state) => state.confirm);
  const { createEditor, loadError, retry } = useDiffsEditorFactory<undefined>();
  const snapshot = useQuery({
    ...orpc.artifacts.readForEdit.queryOptions({ input: { id: artifact.id } }),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [draft, setDraft] = useState<ArtifactEditDraft | null>(null);
  const save = useMutation(orpc.artifacts.saveEdit.mutationOptions());

  useEffect(() => {
    if (snapshot.data && !draft) setDraft(createEditDraft(snapshot.data));
  }, [snapshot.data, draft]);

  const dirty = draft !== null && draft.contents !== draft.savedContents;
  useEffect(() => {
    setEditDirty(dirty);
  }, [dirty, setEditDirty]);

  const loadedContents = draft?.loadedContents;
  const file = useMemo(
    () =>
      loadedContents === undefined
        ? null
        : getTextPreviewFile(
            {
              name: artifact.name,
              path: artifact.path,
              mimeType: artifact.mimeType,
            },
            loadedContents,
          ),
    [artifact.name, artifact.path, artifact.mimeType, loadedContents],
  );

  const saveDraft = () => {
    if (!draft || !dirty || draft.conflict || save.isPending) return;
    const contents = draft.contents;
    save.mutate(
      { id: artifact.id, contents, expectedRevision: draft.revision },
      {
        onSuccess: (result) => {
          if (result.status === "conflict") {
            setDraft((current) => current && { ...current, conflict: true });
            return;
          }
          setDraft(
            (current) =>
              current && {
                ...current,
                revision: result.revision,
                savedContents: contents,
              },
          );
          toast.success("Changes saved");
        },
        onError: (error) => {
          toast.error(error.message || "Failed to save changes");
        },
      },
    );
  };

  const editorRef = useRef<HTMLDivElement>(null);
  useHotkey("Mod+S", saveDraft, { target: editorRef, ignoreInputs: false });

  const reload = () => {
    const run = async () => {
      const result = await snapshot.refetch();
      if (result.isSuccess) {
        setDraft(createEditDraft(result.data));
      } else {
        toast.error(result.error?.message || "Failed to reload the file");
      }
    };
    if (!dirty) {
      void run();
      return;
    }
    confirm({
      title: "Reload file from disk?",
      description:
        "Your unsaved edits will be discarded and replaced with the latest version on disk.",
      confirmLabel: "Reload",
      onConfirm: run,
    });
  };

  const copyEdits = () => {
    if (!draft) return;
    void navigator.clipboard.writeText(draft.contents);
    toast.success("Unsaved edits copied");
  };

  let body: React.ReactNode;
  if (snapshot.error && !draft) {
    body = (
      <PreviewMessage>
        {snapshot.error.message || "Failed to load the file"}
      </PreviewMessage>
    );
  } else if (loadError) {
    body = (
      <PreviewMessage>
        <span className="flex items-center gap-2">
          Failed to load the editor.
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={retry}
          >
            Retry
          </Button>
        </span>
      </PreviewMessage>
    );
  } else if (!createEditor || !draft || !file) {
    body = <PreviewMessage>Loading editor…</PreviewMessage>;
  } else {
    body = (
      <div className="max-h-[65vh] overflow-auto rounded-md border border-border/60">
        <EditProvider createEditor={createEditor}>
          <CodeFile
            key={draft.key}
            file={file}
            options={TEXT_EDIT_OPTIONS}
            edit
            onEditChange={({ file: edited }) => {
              setDraft(
                (current) =>
                  current && { ...current, contents: edited.contents },
              );
            }}
          />
        </EditProvider>
      </div>
    );
  }

  return (
    <div ref={editorRef} className="contents">
      {draft?.conflict ? (
        <div className="flex items-center gap-2 rounded-md border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
          <span className="flex-1">
            This file changed on disk after you started editing.
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={copyEdits}
          >
            Copy edits
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={reload}
          >
            Reload
          </Button>
        </div>
      ) : null}
      {body}
      <DialogFooter>
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={stopEditing}
        >
          Done
        </Button>
        <Button
          size="sm"
          className="h-8 gap-1.5"
          disabled={!dirty || draft?.conflict || save.isPending}
          onClick={saveDraft}
        >
          {save.isPending ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Save className="size-3.5" />
          )}
          Save
        </Button>
      </DialogFooter>
    </div>
  );
}

function ArtifactPreview({
  artifact,
  kind,
}: {
  artifact: Artifact;
  kind: ArtifactPreviewKind;
}) {
  const [view, setView] = useState<"preview" | "source">("preview");
  if (!hasArtifactSourceView(artifact)) {
    return (
      <ArtifactPreviewBody artifact={artifact} kind={kind} showSource={false} />
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        aria-label="Preview mode"
        className="self-start"
        value={view}
        onValueChange={(value) => {
          if (value === "preview" || value === "source") setView(value);
        }}
      >
        <ToggleGroupItem value="preview">Preview</ToggleGroupItem>
        <ToggleGroupItem value="source">Source</ToggleGroupItem>
      </ToggleGroup>
      <ArtifactPreviewBody
        artifact={artifact}
        kind={kind}
        showSource={view === "source"}
      />
    </div>
  );
}

function ArtifactPreviewBody({
  artifact,
  kind,
  showSource,
}: {
  artifact: Artifact;
  kind: ArtifactPreviewKind;
  showSource: boolean;
}) {
  const [mediaFailed, setMediaFailed] = useState(false);
  const destination = useQuery(
    orpc.artifacts.getDownloadUrl.queryOptions({ input: { id: artifact.id } }),
  );
  const previewHref = destination.data
    ? `${resolveArtifactHref(destination.data)}?preview=1`
    : null;
  const isText = kind === "text" || showSource;
  const text = useQuery({
    queryKey: ["artifact-text-preview", previewHref],
    queryFn: async () => {
      if (!previewHref) throw new Error("Preview URL is not available");
      const response = await fetch(previewHref);
      if (!response.ok) throw new Error(await response.text());
      return readTextPreview(response);
    },
    enabled: isText && previewHref !== null,
    gcTime: 0,
  });

  const error =
    destination.error ??
    (isText ? text.error : null) ??
    (mediaFailed && !isText ? new Error("Failed to load artifact") : null);
  if (error) {
    return (
      <PreviewMessage>
        {error.message || "Failed to load artifact"}
      </PreviewMessage>
    );
  }
  if (!previewHref) return <PreviewMessage>Loading preview…</PreviewMessage>;

  if (isText) {
    if (!text.data) return <PreviewMessage>Loading preview…</PreviewMessage>;
    return (
      <div className="flex min-h-0 flex-col gap-2">
        <div className="max-h-[65vh] overflow-auto rounded-md border border-border/60">
          <CodeFile
            file={getTextPreviewFile(
              artifact,
              formatTextPreview(text.data.text, artifact.mimeType),
            )}
            options={TEXT_PREVIEW_OPTIONS}
          />
        </div>
        {text.data.truncated ? (
          <p className="text-xs text-muted-foreground">
            Showing the first {formatBytes(MAX_TEXT_PREVIEW_BYTES)}. Download
            the file to see the rest.
          </p>
        ) : null}
      </div>
    );
  }

  if (kind === "image") {
    return (
      <div className="flex min-h-48 items-center justify-center overflow-auto rounded-md border border-border/60 bg-black/20 p-2">
        <img
          src={previewHref}
          alt={artifact.name}
          className="max-h-[70vh] max-w-full object-contain"
          onError={() => setMediaFailed(true)}
        />
      </div>
    );
  }

  if (kind === "pdf") {
    return (
      <iframe
        src={previewHref}
        title={artifact.name}
        className="h-[70vh] w-full rounded-md border border-border/60 bg-white"
      />
    );
  }

  return artifact.kind === "visual" ? (
    <VisualFrame src={previewHref} title={artifact.name} />
  ) : (
    <iframe
      src={previewHref}
      title={artifact.name}
      sandbox={getHtmlPreviewSandbox(artifact.kind)}
      className="h-[70vh] w-full rounded-md border border-border/60 bg-white"
    />
  );
}

function PreviewMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-48 items-center justify-center rounded-md border border-border/60 bg-black/20 px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function VisualFrame({ src, title }: { src: string; title: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [contentHeight, setContentHeight] = useState<number>();

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const height = readVisualContentHeight(event.data);
      if (height !== undefined) setContentHeight(height);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const height = getVisualFrameHeight(contentHeight);
  return (
    <iframe
      ref={frameRef}
      src={src}
      title={title}
      sandbox={getHtmlPreviewSandbox("visual")}
      className={cn("w-full bg-background", !height && "h-[70vh]")}
      style={height ? { height } : undefined}
    />
  );
}
