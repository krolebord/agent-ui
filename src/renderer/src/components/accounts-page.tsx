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
import { formatPlanType } from "@renderer/lib/plan-label";
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
import type { ComponentType, ReactNode, SVGProps } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ClaudeCodeIcon, CodexIcon } from "./session-type-icons";

type AccountProvider = "claude" | "codex";

interface LoginFlowState {
  loginId: string;
  terminalId: string;
  status: "waiting" | "success" | "error";
  error?: string;
}

const LOGIN_COPY: Record<
  AccountProvider,
  { title: string; description: string; successMessage: string }
> = {
  claude: {
    title: "Claude login",
    description:
      "Complete the login in the terminal below (including the browser step). The window closes automatically once credentials are captured.",
    successMessage: "Claude account added",
  },
  codex: {
    title: "Codex login",
    description:
      "Open the link printed in the terminal below and enter the one-time code shown there. The code expires after 15 minutes; the window closes automatically once credentials are captured.",
    successMessage: "Codex account added",
  },
};

function confirmRemoveAccount(
  account: { id: string; label: string },
  remove: (id: string) => Promise<unknown>,
) {
  useConfirmDialogStore.getState().confirm({
    title: "Remove account",
    description: `Remove "${account.label}"? Sessions configured to use it will fall back to the default account.`,
    confirmLabel: "Remove",
    onConfirm: async () => {
      await remove(account.id);
    },
  });
}

export function AccountsPage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/70 px-2 py-1.5">
        <MobileSidebarTrigger className="md:hidden" />
        <Users className="size-3.5 text-muted-foreground max-md:hidden" />
        <span className="text-sm font-medium">Accounts</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
          <ClaudeAccountsSection />
          <CodexAccountsSection />
        </div>
      </div>
    </div>
  );
}

function AccountsSection({
  icon: Icon,
  title,
  description,
  actions,
  children,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  description: ReactNode;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">{title}</span>
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </div>
      <p className="text-muted-foreground text-sm">{description}</p>
      {children}
    </section>
  );
}

function ClaudeAccountsSection() {
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
  const cancelLogin = useMutation(
    orpc.claudeAccounts.cancelManagedLogin.mutationOptions(),
  );
  const removeAccount = useMutation(
    orpc.claudeAccounts.removeAccount.mutationOptions(),
  );

  const startLogin = (reloginAccountId?: string) => {
    setIsAddingSetupToken(false);
    setEditingId(null);
    beginLogin.mutate({ reloginAccountId });
  };

  return (
    <AccountsSection
      icon={ClaudeCodeIcon}
      title="Claude"
      description={
        <>
          Run sessions under different Claude accounts. Accounts added via
          Claude login refresh their tokens automatically and report usage, but
          a session keeps the token it started with — one still running hours
          later needs a restart. Setup-token accounts use long-lived tokens from{" "}
          <code>claude setup-token</code>. The default account uses your regular
          Claude CLI login.
        </>
      }
      actions={
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => startLogin()}
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
        </>
      }
    >
      {isAddingSetupToken ? (
        <SetupTokenEditor
          mode="add"
          onDone={() => setIsAddingSetupToken(false)}
        />
      ) : null}

      <AccountList isEmpty={accounts.length === 0 && !isAddingSetupToken}>
        {accounts.map((account) => (
          <li key={account.id} className="px-3 py-2.5">
            {editingId === account.id ? (
              <ClaudeAccountEditor
                account={account}
                onDone={() => setEditingId(null)}
              />
            ) : (
              <AccountRow
                account={account}
                typeLabel={
                  account.type === "managed" ? "Managed" : "Setup token"
                }
                onRelogin={
                  account.type === "managed" &&
                  account.status === "needs-relogin"
                    ? () => startLogin(account.id)
                    : null
                }
                isLoginPending={beginLogin.isPending}
                isRemovePending={removeAccount.isPending}
                onEdit={() => {
                  setIsAddingSetupToken(false);
                  setEditingId(account.id);
                }}
                onRemove={() =>
                  confirmRemoveAccount(account, (id) =>
                    removeAccount.mutateAsync({ id }),
                  )
                }
              />
            )}
          </li>
        ))}
      </AccountList>

      <ManagedLoginDialog
        provider="claude"
        open={loginDialogOpen}
        loginFlow={loginFlow}
        onCancelLogin={() => cancelLogin.mutate(undefined)}
        onClose={() => setLoginDialogOpen(false)}
      />
    </AccountsSection>
  );
}

function CodexAccountsSection() {
  const accounts = useAppState((s) => s.codexAccounts.accounts);
  const loginFlow = useAppState((s) => s.codexAccounts.loginFlow);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loginDialogOpen, setLoginDialogOpen] = useState(false);

  const beginLogin = useMutation(
    orpc.codexAccounts.beginManagedLogin.mutationOptions({
      onSuccess: () => setLoginDialogOpen(true),
      onError: (error) =>
        toast.error(error.message || "Failed to start Codex login"),
    }),
  );
  const cancelLogin = useMutation(
    orpc.codexAccounts.cancelManagedLogin.mutationOptions(),
  );
  const removeAccount = useMutation(
    orpc.codexAccounts.removeAccount.mutationOptions(),
  );

  const startLogin = (reloginAccountId?: string) => {
    setEditingId(null);
    beginLogin.mutate({ reloginAccountId });
  };

  return (
    <AccountsSection
      icon={CodexIcon}
      title="Codex"
      description={
        <>
          Run sessions under different ChatGPT accounts. Adding an account runs{" "}
          <code>codex login --device-auth</code> in a terminal, where you read
          off the link and one-time code. Tokens refresh automatically and usage
          is reported per account. The default account uses your regular Codex
          CLI login.
        </>
      }
      actions={
        <Button
          type="button"
          size="sm"
          onClick={() => startLogin()}
          disabled={beginLogin.isPending}
        >
          <LogIn className="mr-1.5 size-3.5" />
          Add Codex account
        </Button>
      }
    >
      <AccountList isEmpty={accounts.length === 0}>
        {accounts.map((account) => (
          <li key={account.id} className="px-3 py-2.5">
            {editingId === account.id ? (
              <CodexAccountEditor
                account={account}
                onDone={() => setEditingId(null)}
              />
            ) : (
              <AccountRow
                account={account}
                onRelogin={
                  account.status === "needs-relogin"
                    ? () => startLogin(account.id)
                    : null
                }
                isLoginPending={beginLogin.isPending}
                isRemovePending={removeAccount.isPending}
                onEdit={() => setEditingId(account.id)}
                onRemove={() =>
                  confirmRemoveAccount(account, (id) =>
                    removeAccount.mutateAsync({ id }),
                  )
                }
              />
            )}
          </li>
        ))}
      </AccountList>

      <ManagedLoginDialog
        provider="codex"
        open={loginDialogOpen}
        loginFlow={loginFlow}
        onCancelLogin={() => cancelLogin.mutate(undefined)}
        onClose={() => setLoginDialogOpen(false)}
      />
    </AccountsSection>
  );
}

function AccountList({
  isEmpty,
  children,
}: {
  isEmpty: boolean;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border border-border/60">
      {isEmpty ? (
        <div className="text-muted-foreground p-6 text-center text-sm">
          No accounts yet.
        </div>
      ) : (
        <ul className="divide-y divide-border/40">{children}</ul>
      )}
    </div>
  );
}

function AccountRow({
  account,
  typeLabel,
  onRelogin,
  onEdit,
  onRemove,
  isLoginPending,
  isRemovePending,
}: {
  account: {
    label: string;
    email?: string;
    planType?: string;
    createdAt: number;
    status: "ok" | "needs-relogin";
  };
  typeLabel?: string;
  onRelogin: (() => void) | null;
  onEdit: () => void;
  onRemove: () => void;
  isLoginPending: boolean;
  isRemovePending: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{account.label}</span>
          {typeLabel ? <Badge variant="secondary">{typeLabel}</Badge> : null}
          {account.planType ? (
            <Badge variant="outline">{formatPlanType(account.planType)}</Badge>
          ) : null}
          {account.status === "needs-relogin" ? (
            <Badge variant="destructive">Needs re-login</Badge>
          ) : null}
        </div>
        <div className="text-muted-foreground mt-0.5 text-xs">
          {account.email ? `${account.email} · ` : ""}
          added {new Date(account.createdAt).toLocaleDateString()}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {onRelogin ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isLoginPending}
            onClick={onRelogin}
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
          onClick={onEdit}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-destructive"
          title="Remove account"
          disabled={isRemovePending}
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function ManagedLoginDialog({
  provider,
  open,
  loginFlow,
  onCancelLogin,
  onClose,
}: {
  provider: AccountProvider;
  open: boolean;
  loginFlow: LoginFlowState | null;
  onCancelLogin: () => void;
  onClose: () => void;
}) {
  const copy = LOGIN_COPY[provider];

  const status = loginFlow?.status;
  useEffect(() => {
    if (open && status === "success") {
      toast.success(copy.successMessage);
      onClose();
    }
  }, [open, status, copy.successMessage, onClose]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      return;
    }
    if (loginFlow?.status === "waiting") {
      onCancelLogin();
    }
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[70vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
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

function ClaudeAccountEditor({
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
  return <ClaudeManagedLabelEditor account={account} onDone={onDone} />;
}

function ClaudeManagedLabelEditor({
  account,
  onDone,
}: {
  account: { id: string; label: string };
  onDone: () => void;
}) {
  const updateAccount = useMutation(
    orpc.claudeAccounts.updateAccount.mutationOptions({
      onSuccess: onDone,
      onError: (error) =>
        toast.error(error.message || "Failed to update account"),
    }),
  );

  return (
    <LabelEditor
      inputId="claude-account-label"
      initialLabel={account.label}
      isPending={updateAccount.isPending}
      onSave={(label) => updateAccount.mutate({ id: account.id, label })}
      onCancel={onDone}
    />
  );
}

function CodexAccountEditor({
  account,
  onDone,
}: {
  account: { id: string; label: string };
  onDone: () => void;
}) {
  const updateAccount = useMutation(
    orpc.codexAccounts.updateAccount.mutationOptions({
      onSuccess: onDone,
      onError: (error) =>
        toast.error(error.message || "Failed to update account"),
    }),
  );

  return (
    <LabelEditor
      inputId="codex-account-label"
      initialLabel={account.label}
      isPending={updateAccount.isPending}
      onSave={(label) => updateAccount.mutate({ id: account.id, label })}
      onCancel={onDone}
    />
  );
}

function LabelEditor({
  inputId,
  initialLabel,
  isPending,
  onSave,
  onCancel,
}: {
  inputId: string;
  initialLabel: string;
  isPending: boolean;
  onSave: (label: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initialLabel);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={inputId}>Label</Label>
        <Input
          id={inputId}
          placeholder="e.g. Work, Personal"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </div>
      <EditorActions
        canSave={label.trim().length > 0}
        isPending={isPending}
        onSave={() => onSave(label.trim())}
        onCancel={onCancel}
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
        <Label htmlFor="claude-setup-token-label">Label</Label>
        <Input
          id="claude-setup-token-label"
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
  const accountCount = useAppState(
    (s) => s.claudeAccounts.accounts.length + s.codexAccounts.accounts.length,
  );
  const showAccounts = useMainViewStore((state) => state.showAccounts);

  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">Accounts</div>
        <div className="text-xs text-muted-foreground">
          {accountCount === 0
            ? "Default CLI logins only"
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
