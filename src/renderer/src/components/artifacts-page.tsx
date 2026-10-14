import type { Artifact, ArtifactLocation } from "@main/artifacts-service";
import { MobileSidebarTrigger } from "@renderer/components/mobile-sidebar-trigger";
import { useAppState } from "@renderer/components/sync-state-provider";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { useMainViewStore } from "@renderer/hooks/use-main-view";
import {
  canDeleteArtifactFile,
  describeCleanupResult,
  describeDeleteResult,
} from "@renderer/lib/artifact-cleanup";
import {
  formatTextPreview,
  getArtifactPreviewKind,
  getHtmlPreviewSandbox,
  getVisualFrameHeight,
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
  PackageOpen,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { combine } from "zustand/middleware";
import { useConfirmDialogStore } from "./confirm-dialog";

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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
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
      toast.success(describeCleanupResult(result));
      setSelectedIds(new Set());
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

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
                setSelectedIds(new Set());
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
                  ? "Largest first. Remove artifacts from the list, or delete their files too. Files tracked by git are never deleted."
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
                    selected={selectedIds.has(artifact.id)}
                    onToggle={() => toggleSelected(artifact.id)}
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
          selectedIds={selectedIds}
          onSelect={setSelectedIds}
        />
      ) : null}
    </div>
  );
}

function CleanupBar({
  artifacts,
  locations,
  selectedIds,
  onSelect,
}: {
  artifacts: Artifact[];
  locations: Record<string, ArtifactLocation> | undefined;
  selectedIds: Set<string>;
  onSelect: (ids: Set<string>) => void;
}) {
  const confirm = useConfirmDialogStore((state) => state.confirm);
  const selected = artifacts.filter((artifact) => selectedIds.has(artifact.id));
  const deletable = selected.filter((artifact) =>
    canDeleteArtifactFile(locations?.[artifact.id]),
  );
  const selectedBytes = selected.reduce((sum, a) => sum + a.size, 0);
  const deletableBytes = deletable.reduce((sum, a) => sum + a.size, 0);
  const outsideProjects = artifacts.filter(
    (artifact) => locations?.[artifact.id]?.kind !== "project",
  );
  const allSelected =
    artifacts.length > 0 && selected.length === artifacts.length;
  const dropFromSelection = (ids: string[]) => {
    const next = new Set(selectedIds);
    for (const id of ids) next.delete(id);
    onSelect(next);
  };
  const removeMany = useMutation({
    mutationFn: (ids: string[]) => orpc.artifacts.removeMany.call({ ids }),
    onSuccess: (_data, ids) => {
      dropFromSelection(ids);
      toast.success(
        `Removed ${ids.length} artifact${ids.length === 1 ? "" : "s"}`,
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const deleteFiles = useMutation({
    mutationFn: (ids: string[]) => orpc.artifacts.deleteFiles.call({ ids }),
    onSuccess: (result, ids) => {
      dropFromSelection(ids);
      toast.success(describeDeleteResult(result));
    },
    onError: (error) => toast.error(error.message),
  });
  const busy = removeMany.isPending || deleteFiles.isPending;
  const skippedCount = selected.length - deletable.length;

  return (
    <div className="shrink-0 border-t border-border/70 bg-background/95 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground tabular-nums">
          {selected.length} selected · {formatBytes(selectedBytes)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() =>
            onSelect(
              allSelected ? new Set() : new Set(artifacts.map((a) => a.id)),
            )
          }
        >
          {allSelected ? "Clear selection" : "Select all"}
        </Button>
        {outsideProjects.length ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onSelect(new Set(outsideProjects.map((a) => a.id)))}
          >
            Select outside projects
          </Button>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7"
            disabled={busy || selected.length === 0}
            title="Remove from the list and keep files on disk. Visuals live in app storage, so their files go too."
            onClick={() => removeMany.mutate(selected.map((a) => a.id))}
          >
            Remove from list
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="h-7"
            disabled={busy || deletable.length === 0}
            onClick={() =>
              confirm({
                title: `Delete ${deletable.length} file${deletable.length === 1 ? "" : "s"}?`,
                description: [
                  `${formatBytes(deletableBytes)} will be ${hasNativeDesktopShell ? "moved to the Trash" : "permanently deleted"}, and the artifacts removed from the list.`,
                  skippedCount
                    ? `${skippedCount} selected file${skippedCount === 1 ? " is" : "s are"} tracked by git and will be kept.`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" "),
                confirmLabel: "Delete files",
                onConfirm: async () => {
                  await deleteFiles.mutateAsync(deletable.map((a) => a.id));
                },
              })
            }
          >
            Delete files{deletable.length ? ` (${deletable.length})` : ""}
          </Button>
        </div>
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
      <Badge
        variant="outline"
        className="max-w-40 shrink-0 font-normal text-muted-foreground"
        title={
          location.kind === "project"
            ? location.projectPath
            : "Not inside any project"
        }
      >
        <span className="truncate">
          {location.kind === "project" ? projectName : "Outside projects"}
        </span>
      </Badge>
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
  selected,
  onToggle,
}: {
  artifact: Artifact;
  location: ArtifactLocation | undefined;
  selected: boolean;
  onToggle: () => void;
}) {
  const checkboxId = `artifact-select-${artifact.id}`;
  return (
    <li
      className={cn(
        "flex items-center gap-3 px-3 py-2 transition-colors hover:bg-white/[0.025] md:px-4",
        selected && "bg-primary/5",
      )}
    >
      <Checkbox id={checkboxId} checked={selected} onCheckedChange={onToggle} />
      <label
        htmlFor={checkboxId}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
      >
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
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {formatBytes(artifact.size)}
        </span>
      </label>
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

export const useArtifactPreviewDialogStore = create(
  combine(
    {
      isOpen: false,
      artifactId: null as string | null,
    },
    (set) => ({
      open: (artifactId: string) => {
        set({ isOpen: true, artifactId });
      },
      close: () => {
        set({ isOpen: false });
      },
    }),
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
          <ArtifactPreview key={artifact.id} artifact={artifact} kind={kind} />
          <DialogFooter>
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
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function ArtifactPreview({
  artifact,
  kind,
}: {
  artifact: Artifact;
  kind: NonNullable<ReturnType<typeof getArtifactPreviewKind>>;
}) {
  const [mediaFailed, setMediaFailed] = useState(false);
  const destination = useQuery(
    orpc.artifacts.getDownloadUrl.queryOptions({ input: { id: artifact.id } }),
  );
  const previewHref = destination.data
    ? `${resolveArtifactHref(destination.data)}?preview=1`
    : null;
  const text = useQuery({
    queryKey: ["artifact-text-preview", previewHref],
    queryFn: async () => {
      if (!previewHref) throw new Error("Preview URL is not available");
      const response = await fetch(previewHref);
      if (!response.ok) throw new Error(await response.text());
      return readTextPreview(response);
    },
    enabled: kind === "text" && previewHref !== null,
    gcTime: 0,
  });

  const error =
    destination.error ??
    text.error ??
    (mediaFailed ? new Error("Failed to load artifact") : null);
  if (error) {
    return (
      <PreviewMessage>
        {error.message || "Failed to load artifact"}
      </PreviewMessage>
    );
  }
  if (!previewHref) return <PreviewMessage>Loading preview…</PreviewMessage>;

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

  if (kind === "html") {
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

  if (!text.data) return <PreviewMessage>Loading preview…</PreviewMessage>;
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <pre className="max-h-[65vh] overflow-auto rounded-md border border-border/60 bg-black/35 p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words">
        <code>{formatTextPreview(text.data.text, artifact.mimeType)}</code>
      </pre>
      {text.data.truncated ? (
        <p className="text-xs text-muted-foreground">
          Showing the first {formatBytes(MAX_TEXT_PREVIEW_BYTES)}. Download the
          file to see the rest.
        </p>
      ) : null}
    </div>
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
