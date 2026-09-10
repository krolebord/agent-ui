import { useConnectionState } from "@renderer/hooks/use-connection-state";

export function ConnectionStatusIndicator() {
  const { status } = useConnectionState();

  if (status === "connected") {
    return null;
  }

  return (
    <div className="-translate-x-1/2 pointer-events-none fixed bottom-4 left-1/2 z-50 flex items-center gap-2 rounded-full border border-border/60 bg-background/90 px-3 py-1.5 text-muted-foreground text-xs shadow-lg backdrop-blur">
      <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
      Reconnecting…
    </div>
  );
}
