import { MobileSidebarTrigger } from "@renderer/components/mobile-sidebar-trigger";
import { Button } from "@renderer/components/ui/button";
import { Label } from "@renderer/components/ui/label";
import { Textarea } from "@renderer/components/ui/textarea";
import { orpc } from "@renderer/orpc-client";
import type {
  GlobalInstructionHarness,
  GlobalInstructionsSnapshot,
} from "@shared/global-instructions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, FolderOpen, LoaderCircle, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const HARNESS_LABELS: Record<GlobalInstructionHarness, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

function formatTimestamp(value: number | null): string | null {
  if (value == null) return null;
  return new Date(value).toLocaleString();
}

function InstructionsEditor({
  snapshot,
}: {
  snapshot: GlobalInstructionsSnapshot;
}) {
  const queryClient = useQueryClient();
  const [common, setCommon] = useState(snapshot.common);
  const [claudeOverride, setClaudeOverride] = useState(
    snapshot.overrides.claude,
  );
  const [codexOverride, setCodexOverride] = useState(snapshot.overrides.codex);

  useEffect(() => {
    setCommon(snapshot.common);
    setClaudeOverride(snapshot.overrides.claude);
    setCodexOverride(snapshot.overrides.codex);
  }, [snapshot.common, snapshot.overrides.claude, snapshot.overrides.codex]);

  const dirty = useMemo(
    () =>
      common !== snapshot.common ||
      claudeOverride !== snapshot.overrides.claude ||
      codexOverride !== snapshot.overrides.codex,
    [common, claudeOverride, codexOverride, snapshot],
  );

  const saveMutation = useMutation(
    orpc.globalInstructions.save.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: orpc.globalInstructions.get.key(),
        });
        toast.success("Saved and wrote Claude + Codex instruction files");
      },
      onError: (error) => {
        toast.error(error.message || "Failed to save instructions");
      },
    }),
  );

  const openFolderMutation = useMutation(
    orpc.fs.openFolder.mutationOptions({
      onError: (error) => {
        toast.error(error.message || "Failed to open folder");
      },
    }),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          {snapshot.updatedAt
            ? `Last edited ${formatTimestamp(snapshot.updatedAt)}`
            : "Not saved yet"}
        </p>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || saveMutation.isPending}
          onClick={() => {
            saveMutation.mutate({
              common,
              overrides: {
                claude: claudeOverride,
                codex: codexOverride,
              },
            });
          }}
        >
          {saveMutation.isPending ? (
            <LoaderCircle className="mr-1.5 size-3.5 animate-spin" />
          ) : (
            <Save className="mr-1.5 size-3.5" />
          )}
          Save & push
        </Button>
      </div>

      <section className="rounded-md border border-border/60 p-4">
        <div className="mb-3 space-y-1">
          <h2 className="text-sm font-medium">Common instructions</h2>
          <p className="text-muted-foreground text-xs">
            Included in every harness file.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="global-instructions-common">Content</Label>
          <Textarea
            id="global-instructions-common"
            value={common}
            onChange={(event) => {
              setCommon(event.target.value);
            }}
            spellCheck={false}
            className="min-h-48 font-mono text-xs md:text-xs"
            placeholder="Preferences that apply to Claude Code and Codex…"
          />
        </div>
      </section>

      {snapshot.harnesses.map((harness) => {
        const value =
          harness.target === "claude" ? claudeOverride : codexOverride;
        const setValue =
          harness.target === "claude" ? setClaudeOverride : setCodexOverride;
        const lastPushed = formatTimestamp(harness.lastPushedAt);

        return (
          <section
            key={harness.target}
            className="rounded-md border border-border/60 p-4"
          >
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <h2 className="text-sm font-medium">
                  {HARNESS_LABELS[harness.target]} override
                </h2>
                <p className="text-muted-foreground font-mono text-xs break-all">
                  {harness.displayPath}
                </p>
                <p className="text-muted-foreground text-xs">
                  Appended after common content.
                  {lastPushed
                    ? ` Last pushed ${lastPushed}.`
                    : " Not pushed yet."}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="size-8 px-0"
                aria-label={`Open folder for ${HARNESS_LABELS[harness.target]}`}
                title="Open folder"
                onClick={() => {
                  openFolderMutation.mutate({ path: harness.directoryPath });
                }}
              >
                <FolderOpen className="size-3.5" />
              </Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`global-instructions-${harness.target}`}>
                Override
              </Label>
              <Textarea
                id={`global-instructions-${harness.target}`}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                }}
                spellCheck={false}
                className="min-h-32 font-mono text-xs md:text-xs"
                placeholder={`Optional ${HARNESS_LABELS[harness.target]}-only additions…`}
              />
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function GlobalInstructionsPage() {
  const snapshotQuery = useQuery(orpc.globalInstructions.get.queryOptions());

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/70 px-2 py-1.5">
        <MobileSidebarTrigger className="md:hidden" />
        <FileText className="size-3.5 text-muted-foreground max-md:hidden" />
        <span className="text-sm font-medium">Global instructions</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
          <p className="text-muted-foreground text-sm">
            Desired content is stored in Agent UI. Save composes common +
            overrides and overwrites each harness file. Existing files are not
            imported.
          </p>

          {snapshotQuery.isLoading ? (
            <div className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
              <LoaderCircle className="size-3.5 animate-spin" />
              Loading…
            </div>
          ) : snapshotQuery.isError ? (
            <div className="text-destructive p-6 text-sm">
              {snapshotQuery.error.message || "Failed to load instructions"}
            </div>
          ) : snapshotQuery.data ? (
            <InstructionsEditor snapshot={snapshotQuery.data} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
