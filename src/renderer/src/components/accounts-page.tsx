import { useConfirmDialogStore } from "@renderer/components/confirm-dialog";
import { LiveTerminalSurface } from "@renderer/components/live-terminal-surface";
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
import { Label } from "@renderer/components/ui/label";
import { useMainViewStore } from "@renderer/hooks/use-main-view";
import { orpc } from "@renderer/orpc-client";
import { useMutation } from "@tanstack/react-query";
import {
  KeyRound,
  LoaderCircle,
  LogIn,
  Pencil,
  Trash2,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export function formatClaudePlan(planType: string): string {
  return planType
    .split(/[_-]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function AccountsPage() {
  const accounts = useAppState((s) => s.claudeAccounts.accounts);
  const loginFlow = useAppState((s) => s.claudeAccounts.loginFlow);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAddingSetupToken, setIsAddingSetupToken] = useState(false);
  const [loginDialogOpen, setLoginDialogOpen] = useState(false);

  const beginLogin = useMutation(
    orpc.claudeAccounts.beginManagedLogin.mutationOptions({
      onSuccess: () => setLoginDialogOpen(true),
      onError: (error) =>
        toast.error(error.message || "Failed to start Claude login"),
    }),
  );
  const removeAccount = useMutation(
    orpc.claudeAccounts.removeAccount.mutationOptions(),
  );

  const startLogin = (reloginAccountId?: string) => {
    setIsAddingSetupToken(false);
    setEditingId(null);
    beginLogin.mutate({ reloginAccountId });
  };

  const handleRemove = (account: { id: string; label: string }) => {
    useConfirmDialogStore.getState().confirm({
      title: "Remove account",
      description: `Remove "${account.label}"? Sessions configured to use it will fall back to the default account.`,
      confirmLabel: "Remove",
      onConfirm: async () => {
        await removeAccount.mutateAsync({ id: account.id });
      },
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/70 px-2 py-1.5">
        <MobileSidebarTrigger className="md:hidden" />
        <Users className="size-3.5 text-muted-foreground max-md:hidden" />
        <span className="text-sm font-medium">Claude accounts</span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              startLogin();
              setEditingId(null);
            }}
            disabled={beginLogin.isPending}
          >
            <LogIn className="mr-1.5 size-3.5" />
            Claude login
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setEditingId(null);
              setIsAddingSetupToken(true);
            }}
          >
            <KeyRound className="mr-1.5 size-3.5" />
            Add setup token
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
          <p className="text-muted-foreground text-sm">
            Run sessions under different Claude accounts. Accounts added via
            Claude login refresh their tokens automatically and report usage,
            but a session keeps the token it started with — one still running
            hours later needs a restart. Setup-token accounts use long-lived
            tokens from <code>claude setup-token</code>. The default account
            uses your regular Claude CLI login.
          </p>

          {isAddingSetupToken ? (
            <SetupTokenEditor
              mode="add"
              onDone={() => setIsAddingSetupToken(false)}
            />
          ) : null}

          <div className="rounded-md border border-border/60">
            {accounts.length === 0 && !isAddingSetupToken ? (
              <div className="text-muted-foreground p-6 text-center text-sm">
                No accounts yet.
              </div>
            ) : (
              <ul className="divide-y divide-border/40">
                {accounts.map((account) => (
                  <li key={account.id} className="px-3 py-2.5">
                    {editingId === account.id ? (
                      <AccountEditor
                        account={account}
                        onDone={() => setEditingId(null)}
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium">
                              {account.label}
                            </span>
                            <Badge variant="secondary">
                              {account.type === "managed"
                                ? "Managed"
                                : "Setup token"}
                            </Badge>
                            {account.planType ? (
                              <Badge variant="outline">
                                {formatClaudePlan(account.planType)}
                              </Badge>
                            ) : null}
                            {account.status === "needs-relogin" ? (
                              <Badge variant="destructive">
                                Needs re-login
                              </Badge>
                            ) : null}
                          </div>
                          <div className="text-muted-foreground mt-0.5 text-xs">
                            {account.email ? `${account.email} · ` : ""}
                            added{" "}
                            {new Date(account.createdAt).toLocaleDateString()}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {account.type === "managed" &&
                          account.status === "needs-relogin" ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={beginLogin.isPending}
                              onClick={() => startLogin(account.id)}
                            >
                              <LogIn className="mr-1.5 size-3.5" />
                              Log in again
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            title="Edit account"
                            onClick={() => {
                              setIsAddingSetupToken(false);
                              setEditingId(account.id);
                            }}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground hover:text-destructive"
                            title="Remove account"
                            disabled={removeAccount.isPending}
                            onClick={() => handleRemove(account)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <ManagedLoginDialog
        open={loginDialogOpen}
        loginFlow={loginFlow}
        onClose={() => setLoginDialogOpen(false)}
      />
    </div>
  );
}

function ManagedLoginDialog({
  open,
  loginFlow,
  onClose,
}: {
  open: boolean;
  loginFlow: {
    loginId: string;
    terminalId: string;
    status: "waiting" | "success" | "error";
    error?: string;
  } | null;
  onClose: () => void;
}) {
  const cancelLogin = useMutation(
    orpc.claudeAccounts.cancelManagedLogin.mutationOptions(),
  );

  const status = loginFlow?.status;
  useEffect(() => {
    if (open && status === "success") {
      toast.success("Claude account added");
      onClose();
    }
  }, [open, status, onClose]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      return;
    }
    if (loginFlow?.status === "waiting") {
      cancelLogin.mutate(undefined);
    }
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[70vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Claude login</DialogTitle>
          <DialogDescription>
            Complete the login in the terminal below (including the browser
            step). The window closes automatically once credentials are
            captured.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border/60 bg-black">
          {loginFlow ? (
            <LiveTerminalSurface
              terminalId={loginFlow.terminalId}
              trackGlobalSize={false}
              attachKey={loginFlow.loginId}
            />
          ) : null}
        </div>
        {loginFlow?.status === "error" ? (
          <p className="text-destructive text-sm">
            {loginFlow.error ?? "Login failed."}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => handleOpenChange(false)}
          >
            {loginFlow?.status === "error" ? "Close" : "Cancel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountEditor({
  account,
  onDone,
}: {
  account: {
    id: string;
    type: "setup-token" | "managed";
    label: string;
  };
  onDone: () => void;
}) {
  if (account.type === "setup-token") {
    return <SetupTokenEditor mode="edit" account={account} onDone={onDone} />;
  }
  return <ManagedLabelEditor account={account} onDone={onDone} />;
}

function ManagedLabelEditor({
  account,
  onDone,
}: {
  account: { id: string; label: string };
  onDone: () => void;
}) {
  const [label, setLabel] = useState(account.label);
  const updateAccount = useMutation(
    orpc.claudeAccounts.updateAccount.mutationOptions({
      onSuccess: onDone,
      onError: (error) =>
        toast.error(error.message || "Failed to update account"),
    }),
  );

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="claude-account-label">Label</Label>
        <Input
          id="claude-account-label"
          placeholder="e.g. Work, Personal"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </div>
      <EditorActions
        canSave={label.trim().length > 0}
        isPending={updateAccount.isPending}
        onSave={() =>
          updateAccount.mutate({ id: account.id, label: label.trim() })
        }
        onCancel={onDone}
      />
    </div>
  );
}

function SetupTokenEditor({
  mode,
  account,
  onDone,
}: {
  mode: "add" | "edit";
  account?: { id: string; label: string };
  onDone: () => void;
}) {
  const [label, setLabel] = useState(account?.label ?? "");
  const [token, setToken] = useState("");

  const addAccount = useMutation(
    orpc.claudeAccounts.addAccount.mutationOptions({
      onSuccess: onDone,
      onError: (error) => toast.error(error.message || "Failed to add account"),
    }),
  );
  const updateAccount = useMutation(
    orpc.claudeAccounts.updateAccount.mutationOptions({
      onSuccess: onDone,
      onError: (error) =>
        toast.error(error.message || "Failed to update account"),
    }),
  );

  const canSave =
    label.trim().length > 0 && (mode === "edit" || token.trim().length > 0);
  const isPending = addAccount.isPending || updateAccount.isPending;

  const handleSave = () => {
    const trimmedLabel = label.trim();
    const trimmedToken = token.trim();
    if (mode === "add") {
      addAccount.mutate({ label: trimmedLabel, token: trimmedToken });
      return;
    }
    if (!account) {
      return;
    }
    updateAccount.mutate({
      id: account.id,
      label: trimmedLabel,
      token: trimmedToken || undefined,
    });
  };

  return (
    <div className="space-y-3 rounded-lg border border-border/60 p-3">
      <div className="space-y-2">
        <Label htmlFor="claude-account-label">Label</Label>
        <Input
          id="claude-account-label"
          placeholder="e.g. Work, Personal"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="claude-account-token">Setup token</Label>
        <Input
          id="claude-account-token"
          type="password"
          placeholder={
            mode === "edit"
              ? "Leave blank to keep current token"
              : "sk-ant-oat01-…"
          }
          className="font-mono"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Generate with <span className="font-mono">claude setup-token</span>{" "}
          while logged into the account you want to add.
        </p>
      </div>
      <EditorActions
        canSave={canSave}
        isPending={isPending}
        onSave={handleSave}
        onCancel={onDone}
      />
    </div>
  );
}

function EditorActions({
  canSave,
  isPending,
  onSave,
  onCancel,
}: {
  canSave: boolean;
  isPending: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={!canSave || isPending}
        onClick={onSave}
      >
        {isPending ? (
          <LoaderCircle className="mr-1.5 size-3.5 animate-spin" />
        ) : null}
        Save
      </Button>
    </div>
  );
}

export function AccountsSettingsItem({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const accountCount = useAppState((s) => s.claudeAccounts.accounts.length);
  const showAccounts = useMainViewStore((state) => state.showAccounts);

  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">Claude accounts</div>
        <div className="text-xs text-muted-foreground">
          {accountCount === 0
            ? "Default CLI login only"
            : `${accountCount} extra account${accountCount === 1 ? "" : "s"}`}
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          showAccounts();
          onNavigate?.();
        }}
      >
        Manage
      </Button>
    </div>
  );
}
