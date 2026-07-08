import { useMobileNavStore } from "@renderer/hooks/use-mobile-nav";
import { cn } from "@renderer/lib/utils";
import { Menu } from "lucide-react";
import { useAppState } from "./sync-state-provider";
import { Button } from "./ui/button";

const ATTENTION_STATUSES = new Set([
  "awaiting_user_response",
  "awaiting_approval",
]);

export function MobileSidebarTrigger({ className }: { className?: string }) {
  const openSidebar = useMobileNavStore((state) => state.openSidebar);
  const attentionCount = useAppState(
    (state) =>
      Object.values(state.sessions).filter((session) =>
        ATTENTION_STATUSES.has(session.status),
      ).length,
  );

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn("relative size-8 px-0", className)}
      onClick={openSidebar}
      aria-label="Open sessions menu"
    >
      <Menu className="size-4" />
      {attentionCount > 0 ? (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 font-mono text-[10px] font-medium leading-none text-white">
          {attentionCount > 9 ? "9+" : attentionCount}
        </span>
      ) : null}
    </Button>
  );
}
