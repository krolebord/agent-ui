import { useConfirmDialogStore } from "@renderer/components/confirm-dialog";
import { MobileSidebarTrigger } from "@renderer/components/mobile-sidebar-trigger";
import { useAppState } from "@renderer/components/sync-state-provider";
import { Button } from "@renderer/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/ui/collapsible";
import { Input } from "@renderer/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Switch } from "@renderer/components/ui/switch";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@renderer/components/ui/toggle-group";
import {
  type ConversationSearchMode,
  conversationLabel,
  conversationProjectName,
  describeClearIndexWarning,
  describeEmbeddingProgress,
  describeForgetWarning,
  describeSearchCoverage,
  describeSemanticSearchFailure,
  describeTurnMatch,
  embeddingStatusLabels,
  formatActivityDate,
  formatCount,
  formatMegabytes,
  progressPercent,
  projectFilterOptions,
  resolveSearchMode,
  semanticSearchUnavailableReason,
} from "@renderer/lib/session-memory-view";
import { formatUsageAge } from "@renderer/lib/usage-view";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import {
  type SessionMemoryAgent,
  type SessionMemoryConversationSummary,
  type SessionMemoryEmbeddingState,
  type SessionMemoryTurnMatch,
  sessionMemoryAgents,
} from "@shared/session-memory";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Brain,
  ChevronRight,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

const AGE_TICK_MS = 30_000;
const CONVERSATION_PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 250;
const CONFIRM_TITLE_MAX_CHARS = 60;
const ALL_PROJECTS = "all";

const agentLabels: Record<SessionMemoryAgent, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
};

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-500"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-border/70 p-4">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function ErrorText({ children }: { children: ReactNode }) {
  return <p className="text-xs break-words text-destructive">{children}</p>;
}

function showError(error: unknown, fallback = "Session memory request failed") {
  toast.error(
    error instanceof Error && error.message ? error.message : fallback,
  );
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function useInvalidateSessionMemory() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: orpc.sessionMemory.key() });
}

function shorten(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

const relationLabels: Record<
  SessionMemoryConversationSummary["relation"],
  string | null
> = {
  main: null,
  fork: "fork",
  subagent: "subagent",
};

function ConversationRow({
  conversation,
  match,
  now,
  onForget,
}: {
  conversation: SessionMemoryConversationSummary;
  match?: SessionMemoryTurnMatch;
  now: number;
  onForget: () => void;
}) {
  const label = conversationLabel(conversation);
  const details = [
    conversationProjectName(conversation),
    formatActivityDate(conversation.updatedAt ?? conversation.startedAt, now),
    `${formatCount(conversation.turnCount)} turn${conversation.turnCount === 1 ? "" : "s"}`,
    relationLabels[conversation.relation],
  ].filter((detail): detail is string => Boolean(detail));

  return (
    <li
      className={cn("flex gap-3 py-2", match ? "items-start" : "items-center")}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded border border-border/70 px-1.5 text-[11px] leading-4 text-muted-foreground">
            {agentLabels[conversation.agent]}
          </span>
          <span className="truncate text-sm" title={label}>
            {label}
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {details.join(" · ")}
          {conversation.transcriptOnDisk ? null : (
            <span
              className="text-muted-foreground/70 italic"
              title="The transcript file was deleted; the index holds the only copy."
            >
              {" · transcript deleted"}
            </span>
          )}
        </p>
        {match ? (
          <div className="mt-1 space-y-0.5 border-l-2 border-border/70 pl-2">
            <p
              className="text-[11px] text-muted-foreground/80 tabular-nums"
              title="Relevance is cosine similarity; higher is closer."
            >
              {describeTurnMatch(match, conversation.turnCount, now)}
            </p>
            <p className="line-clamp-3 text-xs break-words text-muted-foreground">
              {match.snippet}
            </p>
          </div>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onForget}
      >
        Forget
      </Button>
    </li>
  );
}

function ForgottenConversations({ now }: { now: number }) {
  const invalidate = useInvalidateSessionMemory();
  const forgotten = useQuery(orpc.sessionMemory.listForgotten.queryOptions());
  const restore = useMutation(
    orpc.sessionMemory.restoreForgotten.mutationOptions({
      onSuccess: () => {
        toast.success(
          "Restored. It is indexed again on this sync if its transcript is still on disk.",
        );
        void invalidate();
      },
      onError: (error) => showError(error),
    }),
  );
  const entries = forgotten.data ?? [];
  if (entries.length === 0) {
    return null;
  }

  return (
    <Collapsible className="border-t border-border/70 pt-3">
      <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        Forgotten conversations ({formatCount(entries.length)})
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="pt-2 text-xs text-muted-foreground">
          Sync skips these. Restoring one indexes it again if its transcript
          still exists.
        </p>
        <ul className="divide-y divide-border/50">
          {entries.map((entry) => (
            <li
              key={`${entry.agent}:${entry.nativeId}`}
              className="flex items-center gap-3 py-2"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <p
                  className="truncate text-sm"
                  title={entry.label ?? undefined}
                >
                  {entry.label ?? "Untitled conversation"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {agentLabels[entry.agent]} · forgotten{" "}
                  {formatActivityDate(entry.forgottenAt, now)}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                disabled={restore.isPending}
                onClick={() =>
                  restore.mutate({
                    agent: entry.agent,
                    nativeId: entry.nativeId,
                  })
                }
              >
                Restore
              </Button>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function IndexedConversationsSection({
  now,
  lastSyncFinishedAt,
  embedding,
}: {
  now: number;
  lastSyncFinishedAt: number | null;
  embedding: SessionMemoryEmbeddingState;
}) {
  const [search, setSearch] = useState("");
  const [agent, setAgent] = useState<SessionMemoryAgent | "all">("all");
  const [project, setProject] = useState<string>(ALL_PROJECTS);
  const [chosenMode, setChosenMode] = useState<ConversationSearchMode | null>(
    null,
  );
  const [semanticFailure, setSemanticFailure] = useState<string | null>(null);
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
  const projects = useAppState((state) => state.projects);
  const projectOptions = useMemo(
    () => projectFilterOptions(projects),
    [projects],
  );
  const query = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);
  const queryClient = useQueryClient();
  const invalidate = useInvalidateSessionMemory();
  const confirm = useConfirmDialogStore((state) => state.confirm);

  const unavailableReason = semanticSearchUnavailableReason(embedding);
  const mode = resolveSearchMode(
    chosenMode,
    unavailableReason === null && semanticFailure === null,
  );
  const agentFilter = agent === "all" ? undefined : agent;
  const projectPath = projectOptions.some((option) => option.path === project)
    ? project
    : undefined;

  const conversations = useInfiniteQuery({
    ...orpc.sessionMemory.listConversations.infiniteOptions({
      input: (offset: number) => ({
        query: query || undefined,
        agent: agentFilter,
        projectPath,
        limit: CONVERSATION_PAGE_SIZE,
        offset,
      }),
      initialPageParam: 0,
      getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    }),
    placeholderData: keepPreviousData,
    enabled: mode === "text",
  });

  const semantic = useQuery({
    ...orpc.sessionMemory.searchConversations.queryOptions({
      input: {
        query: submittedQuery ?? "",
        agent: agentFilter,
        projectPath,
      },
    }),
    enabled: mode === "semantic" && submittedQuery !== null,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (semantic.error) {
      setSemanticFailure(describeSemanticSearchFailure(semantic.error.message));
    }
  }, [semantic.error]);

  const seenSync = useRef(lastSyncFinishedAt);
  useEffect(() => {
    if (seenSync.current === lastSyncFinishedAt) return;
    seenSync.current = lastSyncFinishedAt;
    void queryClient.invalidateQueries({
      queryKey: orpc.sessionMemory.listConversations.key(),
    });
  }, [lastSyncFinishedAt, queryClient]);

  const runSemanticSearch = () => {
    const trimmed = search.trim();
    if (!trimmed) {
      setSubmittedQuery(null);
    } else if (trimmed === submittedQuery) {
      void semantic.refetch();
    } else {
      setSubmittedQuery(trimmed);
    }
  };

  const changeMode = (value: string) => {
    if (value !== "semantic" && value !== "text") return;
    setChosenMode(value);
    if (value === "semantic") {
      setSemanticFailure(null);
      setSubmittedQuery(search.trim() || null);
    }
  };

  const forget = (conversation: SessionMemoryConversationSummary) =>
    confirm({
      title: `Forget “${shorten(conversationLabel(conversation), CONFIRM_TITLE_MAX_CHARS)}”?`,
      description: describeForgetWarning(conversation),
      confirmLabel: "Forget",
      onConfirm: async () => {
        try {
          await orpc.sessionMemory.forgetConversation.call({
            id: conversation.id,
          });
        } catch (error) {
          showError(error, "Failed to forget the conversation");
        }
        await invalidate();
      },
    });

  const filtered = agent !== "all" || projectPath !== undefined;
  const textItems = conversations.data?.pages.flatMap(
    (page) => page.conversations,
  );
  const matches = semantic.data?.conversations;
  const semanticPending = semantic.isFetching;
  const notice =
    mode === "text"
      ? (semanticFailure ?? unavailableReason)
      : describeSearchCoverage(embedding);

  let results: ReactNode;
  if (mode === "semantic") {
    if (submittedQuery === null) {
      results = (
        <p className="text-xs text-muted-foreground">
          Describe what you are looking for and press Enter to find
          conversations by meaning.
        </p>
      );
    } else if (matches === undefined) {
      results = (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" />
          Searching…
        </p>
      );
    } else if (matches.length === 0) {
      results = (
        <p className="text-xs text-muted-foreground">No conversations match.</p>
      );
    } else {
      results = (
        <ul
          className={cn(
            "divide-y divide-border/50",
            (semantic.isPlaceholderData || semanticPending) && "opacity-60",
          )}
        >
          {matches.map(({ conversation, turns }) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              match={turns[0]}
              now={now}
              onForget={() => forget(conversation)}
            />
          ))}
        </ul>
      );
    }
  } else if (conversations.isError) {
    results = <ErrorText>{conversations.error.message}</ErrorText>;
  } else if (textItems === undefined) {
    results = <p className="text-xs text-muted-foreground">Loading…</p>;
  } else if (textItems.length === 0) {
    results = (
      <p className="text-xs text-muted-foreground">
        {query || filtered ? "No conversations match." : "Nothing indexed yet."}
      </p>
    );
  } else {
    results = (
      <ul
        className={cn(
          "divide-y divide-border/50",
          conversations.isPlaceholderData && "opacity-60",
        )}
      >
        {textItems.map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            now={now}
            onForget={() => forget(conversation)}
          />
        ))}
      </ul>
    );
  }

  return (
    <Section
      title="Indexed conversations"
      action={
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label="Search mode"
          value={mode}
          onValueChange={changeMode}
        >
          <ToggleGroupItem
            value="semantic"
            disabled={unavailableReason !== null}
            title={unavailableReason ?? "Search by meaning"}
          >
            Semantic
          </ToggleGroupItem>
          <ToggleGroupItem value="text" title="Match titles and first messages">
            Text
          </ToggleGroupItem>
        </ToggleGroup>
      }
    >
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (mode === "semantic") runSemanticSearch();
        }}
      >
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              if (!event.target.value.trim()) setSubmittedQuery(null);
            }}
            placeholder={
              mode === "semantic"
                ? "Describe the work, e.g. benchmark OCR models"
                : "Search titles and first messages"
            }
            aria-label="Search indexed conversations"
            className="h-8 pl-8 text-xs"
          />
        </div>
        {mode === "semantic" ? (
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={!search.trim()}
          >
            {semanticPending ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : null}
            Search
          </Button>
        ) : null}
        <Select
          value={agent}
          onValueChange={(value) =>
            setAgent(value as SessionMemoryAgent | "all")
          }
        >
          <SelectTrigger size="sm" className="w-32 text-xs" aria-label="Agent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {sessionMemoryAgents.map((value) => (
              <SelectItem key={value} value={value}>
                {agentLabels[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {projectOptions.length > 0 ? (
          <Select
            value={projectPath ?? ALL_PROJECTS}
            onValueChange={setProject}
          >
            <SelectTrigger
              size="sm"
              className="w-36 text-xs"
              aria-label="Project"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
              {projectOptions.map((option) => (
                <SelectItem
                  key={option.path}
                  value={option.path}
                  title={option.path}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </form>

      {notice ? (
        <p className="text-xs text-muted-foreground">{notice}</p>
      ) : null}

      {results}
      {mode === "text" && conversations.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          disabled={conversations.isFetchingNextPage}
          onClick={() => void conversations.fetchNextPage()}
        >
          {conversations.isFetchingNextPage ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : null}
          Load more
        </Button>
      ) : null}

      <ForgottenConversations now={now} />
    </Section>
  );
}

function ClearIndexSection({ enabled }: { enabled: boolean }) {
  const invalidate = useInvalidateSessionMemory();
  const confirm = useConfirmDialogStore((state) => state.confirm);
  const [preparing, setPreparing] = useState(false);
  const preview = useQuery({
    ...orpc.sessionMemory.getClearIndexPreview.queryOptions(),
    enabled: !enabled,
  });
  if (!enabled && !preview.data?.conversations) {
    return null;
  }

  const openConfirm = async () => {
    setPreparing(true);
    try {
      const current = await orpc.sessionMemory.getClearIndexPreview.call();
      confirm({
        title: "Clear the session memory index?",
        description: describeClearIndexWarning(current, enabled),
        confirmLabel: "Clear index",
        onConfirm: async () => {
          try {
            await orpc.sessionMemory.clearIndex.call();
            toast.success("Session memory index cleared");
          } catch (error) {
            showError(error, "Failed to clear the index");
          }
          await invalidate();
        },
      });
    } catch (error) {
      showError(error);
    } finally {
      setPreparing(false);
    }
  };

  return (
    <section className="rounded-lg border border-destructive/40 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium text-destructive">Clear index</h2>
          <p className="text-xs text-muted-foreground">
            Deletes every indexed conversation and embedding, then rebuilds from
            the transcripts still on disk. Conversations whose transcripts were
            deleted cannot be rebuilt.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={preparing}
          onClick={() => void openConfirm()}
        >
          {preparing ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Trash2 className="size-3.5" />
          )}
          Clear index
        </Button>
      </div>
    </section>
  );
}

export function MemoryPage() {
  const memory = useAppState((state) => state.sessionMemory);
  const now = useNow(AGE_TICK_MS);
  const onError = (error: Error) =>
    toast.error(error.message || "Session memory request failed");

  const setEnabled = useMutation(
    orpc.sessionMemory.setEnabled.mutationOptions({ onError }),
  );
  const syncNow = useMutation(
    orpc.sessionMemory.syncNow.mutationOptions({ onError }),
  );
  const setPaused = useMutation(
    orpc.sessionMemory.setEmbeddingPaused.mutationOptions({ onError }),
  );
  const retry = useMutation(
    orpc.sessionMemory.retryEmbedding.mutationOptions({ onError }),
  );

  const { embedding, counts } = memory;
  const syncing = memory.syncStatus === "syncing" || syncNow.isPending;
  const lastSync = formatUsageAge(memory.lastSyncFinishedAt, now);
  const progress = describeEmbeddingProgress(embedding);
  const paused = embedding.status === "paused";
  const canPause =
    embedding.status === "embedding" ||
    embedding.status === "downloading" ||
    embedding.status === "idle";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/70 px-2 py-1.5">
        <MobileSidebarTrigger className="md:hidden" />
        <Brain className="size-3.5 text-muted-foreground max-md:hidden" />
        <span className="text-sm font-medium">Memory</span>
        {memory.enabled ? (
          <span className="text-xs text-muted-foreground">
            {embeddingStatusLabels[embedding.status]}
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
          <Section title="Session memory">
            <div className="flex items-start justify-between gap-4">
              <p className="text-xs text-muted-foreground">
                Indexes Claude, Codex and Cursor transcripts on this machine so
                agents can search past sessions. Downloads a ~350 MB embedding
                model and runs it locally at low CPU priority.
              </p>
              <Switch
                aria-label="Enable session memory"
                checked={memory.enabled}
                disabled={setEnabled.isPending}
                onCheckedChange={(enabled) => setEnabled.mutate({ enabled })}
              />
            </div>
          </Section>

          {memory.enabled ? (
            <>
              <Section
                title="Transcript index"
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={syncing}
                    onClick={() => syncNow.mutate(undefined)}
                  >
                    <RefreshCw
                      className={cn(
                        "mr-1.5 size-3.5",
                        syncing && "animate-spin",
                      )}
                    />
                    Sync now
                  </Button>
                }
              >
                <p className="text-xs text-muted-foreground">
                  {memory.syncStatus === "syncing"
                    ? memory.progress && memory.progress.total > 0
                      ? `Syncing ${formatCount(memory.progress.done)} of ${formatCount(memory.progress.total)} transcripts…`
                      : "Syncing…"
                    : lastSync
                      ? `Last synced ${lastSync}${
                          memory.lastSyncDurationMs !== null
                            ? ` in ${(memory.lastSyncDurationMs / 1_000).toFixed(1)} s`
                            : ""
                        }`
                      : "Not synced yet"}
                </p>
                {memory.syncStatus === "syncing" &&
                memory.progress &&
                memory.progress.total > 0 ? (
                  <ProgressBar
                    percent={progressPercent(
                      memory.progress.done,
                      memory.progress.total,
                    )}
                  />
                ) : null}
                {counts ? (
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
                    {sessionMemoryAgents.map((agent) => (
                      <div key={agent} className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">
                          {agentLabels[agent]}
                        </dt>
                        <dd className="tabular-nums">
                          {formatCount(counts.conversations[agent])}
                        </dd>
                      </div>
                    ))}
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Turns</dt>
                      <dd className="tabular-nums">
                        {formatCount(counts.turns)}
                      </dd>
                    </div>
                  </dl>
                ) : null}
                {counts && counts.sources.failed > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {formatCount(counts.sources.failed)} transcript
                    {counts.sources.failed === 1 ? "" : "s"} could not be read
                  </p>
                ) : null}
                {memory.syncStatus === "error" && memory.lastError ? (
                  <ErrorText>{memory.lastError}</ErrorText>
                ) : null}
              </Section>

              <Section
                title="Embeddings"
                action={
                  embedding.status === "error" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={retry.isPending}
                      onClick={() => retry.mutate(undefined)}
                    >
                      <RotateCcw className="mr-1.5 size-3.5" />
                      Retry
                    </Button>
                  ) : paused || canPause ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={setPaused.isPending}
                      onClick={() => setPaused.mutate({ paused: !paused })}
                    >
                      {paused ? (
                        <Play className="mr-1.5 size-3.5" />
                      ) : (
                        <Pause className="mr-1.5 size-3.5" />
                      )}
                      {paused ? "Resume" : "Pause"}
                    </Button>
                  ) : null
                }
              >
                {embedding.status === "unsupported" ? (
                  <p className="text-xs text-muted-foreground">
                    Embedding is not available in this build.
                  </p>
                ) : (
                  <>
                    {embedding.model.status === "downloading" ? (
                      <div className="space-y-1.5">
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <span>Downloading model</span>
                          <span className="tabular-nums">
                            {formatMegabytes(embedding.model.bytesDone)} of{" "}
                            {formatMegabytes(embedding.model.bytesTotal)}
                          </span>
                        </div>
                        <ProgressBar
                          percent={progressPercent(
                            embedding.model.bytesDone,
                            embedding.model.bytesTotal,
                          )}
                        />
                      </div>
                    ) : null}
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap justify-between gap-x-4 text-xs text-muted-foreground">
                        <span className="tabular-nums">
                          {progress.countLabel}
                        </span>
                        <span className="tabular-nums">
                          {[progress.rateLabel, progress.etaLabel]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </div>
                      <ProgressBar percent={progress.percent} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatCount(embedding.turnsPending)} turn
                      {embedding.turnsPending === 1 ? "" : "s"} queued
                      {embedding.turnsSettling > 0
                        ? `, ${formatCount(embedding.turnsSettling)} waiting for active sessions to settle`
                        : ""}
                      {embedding.chunksFailed > 0
                        ? `, ${formatCount(embedding.chunksFailed)} chunk${embedding.chunksFailed === 1 ? "" : "s"} skipped after errors`
                        : ""}
                      {embedding.lastEmbeddedAt !== null &&
                      embedding.status !== "embedding"
                        ? `. Last indexed ${formatUsageAge(embedding.lastEmbeddedAt, now)}`
                        : ""}
                    </p>
                    {embedding.lastError &&
                    (embedding.status === "error" ||
                      embedding.model.status === "error") ? (
                      <ErrorText>{embedding.lastError}</ErrorText>
                    ) : null}
                  </>
                )}
              </Section>

              <IndexedConversationsSection
                now={now}
                lastSyncFinishedAt={memory.lastSyncFinishedAt}
                embedding={embedding}
              />
            </>
          ) : null}

          <ClearIndexSection enabled={memory.enabled} />
        </div>
      </div>
    </div>
  );
}
