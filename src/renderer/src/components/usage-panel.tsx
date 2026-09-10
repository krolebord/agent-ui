import { useActiveSessionId } from "@renderer/hooks/use-active-session-id";
import { orpc } from "@renderer/orpc-client";
import { usageEntryKey } from "@shared/usage-keys";
import { useMutation } from "@tanstack/react-query";
import { BarChart3, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { useAppState } from "./sync-state-provider";
import {
  ClaudeUsageMetrics,
  CodexUsageMetrics,
  CursorUsageMetrics,
} from "./usage-metrics";

type UsageSource = "claude" | "codex" | "cursorAgent";

function PanelShell({ children }: { children: ReactNode }) {
  return <div className="border-t border-border/70 p-2">{children}</div>;
}

function PanelNote({ children }: { children: ReactNode }) {
  return (
    <PanelShell>
      <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-center text-xs text-zinc-500">
        {children}
      </div>
    </PanelShell>
  );
}

function PanelLoading() {
  return (
    <PanelShell>
      <div className="flex items-center justify-center gap-1.5 py-1.5 text-xs text-zinc-400">
        <LoaderCircle className="size-3.5 animate-spin" />
        Loading usage...
      </div>
    </PanelShell>
  );
}

function ShowUsageButton({ onClick }: { onClick: () => void }) {
  return (
    <PanelShell>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-zinc-100 transition hover:bg-white/10"
      >
        <BarChart3 className="size-3.5" />
        Show Usage
      </button>
    </PanelShell>
  );
}

function AccountLabel({ label }: { label: string | null }) {
  if (!label) {
    return null;
  }
  return <div className="text-[10px] text-zinc-500">{label}</div>;
}

export function UsagePanel() {
  const activeSessionId = useActiveSessionId();
  const activeSession = useAppState((x) =>
    activeSessionId ? (x.sessions[activeSessionId] ?? null) : null,
  );

  const usageSource: UsageSource | null =
    activeSession?.type === "claude-local-terminal"
      ? "claude"
      : activeSession?.type === "codex-local-terminal"
        ? "codex"
        : activeSession?.type === "cursor-agent"
          ? "cursorAgent"
          : null;

  const claudeAccountId =
    activeSession?.type === "claude-local-terminal"
      ? activeSession.startupConfig.accountId
      : undefined;
  const claudeAccount = useAppState((x) =>
    claudeAccountId
      ? (x.claudeAccounts.accounts.find(
          (account) => account.id === claudeAccountId,
        ) ?? null)
      : null,
  );
  const claudeAccountLabel = claudeAccount?.label ?? null;
  const claudeUsageUnsupported = claudeAccount?.type === "setup-token";

  const codexAccountId =
    activeSession?.type === "codex-local-terminal"
      ? activeSession.startupConfig.accountId
      : undefined;
  const codexAccount = useAppState((x) =>
    codexAccountId
      ? (x.codexAccounts.accounts.find(
          (account) => account.id === codexAccountId,
        ) ?? null)
      : null,
  );
  const codexAccountLabel = codexAccount?.label ?? null;

  const claudeKey = usageEntryKey("claude", claudeAccountId);
  const codexKey = usageEntryKey("codex", codexAccountId);
  const cursorKey = usageEntryKey("cursor", null);
  const claudeEntry = useAppState((x) => x.usage.entries[claudeKey] ?? null);
  const codexEntry = useAppState((x) => x.usage.entries[codexKey] ?? null);
  const cursorEntry = useAppState((x) => x.usage.entries[cursorKey] ?? null);
  const claudeUsage =
    claudeEntry?.provider === "claude" ? claudeEntry.data : null;
  const codexUsage = codexEntry?.provider === "codex" ? codexEntry.data : null;
  const cursorUsage =
    cursorEntry?.provider === "cursor" ? cursorEntry.data : null;

  const refreshUsage = useMutation(orpc.usage.refresh.mutationOptions());
  const handleRefresh = async (key: string) => {
    try {
      const result = await refreshUsage.mutateAsync({ key });
      if (!result.ok && result.message) {
        toast.error(result.message);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to refresh usage",
      );
    }
  };

  if (!usageSource) {
    return (
      <PanelNote>
        Usage is available for Claude, Codex, and Cursor sessions.
      </PanelNote>
    );
  }

  if (usageSource === "cursorAgent") {
    if (cursorUsage) {
      return (
        <PanelShell>
          <div className="space-y-1.5">
            <CursorUsageMetrics usage={cursorUsage} />
          </div>
        </PanelShell>
      );
    }

    if (cursorEntry?.refreshing) {
      return <PanelLoading />;
    }

    return <ShowUsageButton onClick={() => void handleRefresh(cursorKey)} />;
  }

  if (usageSource === "codex") {
    if (codexUsage) {
      return (
        <PanelShell>
          <div className="space-y-1.5">
            <AccountLabel label={codexAccountLabel} />
            <CodexUsageMetrics usage={codexUsage} />
          </div>
        </PanelShell>
      );
    }

    if (codexEntry?.refreshing) {
      return <PanelLoading />;
    }

    return <ShowUsageButton onClick={() => void handleRefresh(codexKey)} />;
  }

  if (claudeUsageUnsupported) {
    return (
      <PanelShell>
        <div className="space-y-1">
          <AccountLabel label={claudeAccountLabel} />
          <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-center text-xs text-zinc-500">
            Usage is not supported for setup-token accounts.
          </div>
        </div>
      </PanelShell>
    );
  }

  if (claudeUsage) {
    return (
      <PanelShell>
        <div className="space-y-1.5">
          <AccountLabel label={claudeAccountLabel} />
          <ClaudeUsageMetrics usage={claudeUsage} />
        </div>
      </PanelShell>
    );
  }

  if (claudeEntry?.refreshing) {
    return <PanelLoading />;
  }

  return <ShowUsageButton onClick={() => void handleRefresh(claudeKey)} />;
}
