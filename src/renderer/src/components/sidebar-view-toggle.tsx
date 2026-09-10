import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@renderer/components/ui/dropdown-menu";
import { useMainViewStore } from "@renderer/hooks/use-main-view";
import { hasNativeDesktopShell } from "@renderer/lib/native-shell";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import {
  isNavPageId,
  type NavPageId,
  navPageIds,
  navPageLabels,
  type PinnableItemId,
} from "@shared/sidebar-nav";
import { useMutation } from "@tanstack/react-query";
import {
  BarChart3,
  CalendarClock,
  FileText,
  Gauge,
  Inbox,
  ListTree,
  PackageOpen,
  Pin,
  PinOff,
  RefreshCw,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { useSettingsStore } from "./settings-dialog";
import { useAppState } from "./sync-state-provider";

const navPageIcons: Record<
  NavPageId,
  ComponentType<SVGProps<SVGSVGElement>>
> = {
  skills: Sparkles,
  globalInstructions: FileText,
  scheduledSessions: CalendarClock,
  accounts: Users,
  artifacts: PackageOpen,
  usage: BarChart3,
  limits: Gauge,
};

const pageSlotHiddenClasses: Record<"withSwitch" | "withoutSwitch", string[]> =
  {
    withSwitch: [
      "@max-[148px]:hidden",
      "@max-[180px]:hidden",
      "@max-[212px]:hidden",
      "@max-[244px]:hidden",
      "@max-[276px]:hidden",
      "@max-[308px]:hidden",
      "@max-[340px]:hidden",
    ],
    withoutSwitch: [
      "@max-[112px]:hidden",
      "@max-[144px]:hidden",
      "@max-[176px]:hidden",
      "@max-[208px]:hidden",
      "@max-[240px]:hidden",
      "@max-[272px]:hidden",
      "@max-[304px]:hidden",
    ],
  };

export const sidebarHeaderClassName = cn(
  "@container flex h-9 items-center border-b border-border/70 [app-region:drag]",
  hasNativeDesktopShell ? "pl-16" : "pl-2",
);

function usePinnedItems() {
  return useAppState((state) => state.appSettings.pinnedHeaderItems);
}

function useItemPinned(item: PinnableItemId) {
  return useAppState((state) =>
    state.appSettings.pinnedHeaderItems.includes(item),
  );
}

export function SidebarViewToggle() {
  const sidebarView = useAppState((state) => state.appSettings.sidebarView);
  const pinned = useItemPinned("sidebarView");
  const setSidebarView = useMutation(
    orpc.appSettings.setSidebarView.mutationOptions(),
  );

  if (!pinned) return null;

  const isInbox = sidebarView === "inbox";
  const label = isInbox ? "Switch to project view" : "Switch to inbox view";

  return (
    <Button
      variant="flat"
      className={cn("h-full w-9 shrink-0 px-0", isInbox && "text-zinc-100")}
      onClick={() => {
        setSidebarView.mutate({ view: isInbox ? "projects" : "inbox" });
      }}
      aria-label={label}
      title={label}
    >
      {isInbox ? (
        <ListTree className="size-3.5" />
      ) : (
        <Inbox className="size-3.5" />
      )}
    </Button>
  );
}

export function useUnpinnedNavPageActive() {
  const mainView = useMainViewStore((state) => state.view);
  const pinnedItems = usePinnedItems();

  return mainView !== "sessions" && !pinnedItems.includes(mainView);
}

export function PinnedNavButtons() {
  const mainView = useMainViewStore((state) => state.view);
  const toggleView = useMainViewStore((state) => state.toggleView);
  const pinnedItems = usePinnedItems();

  const hiddenClasses = pinnedItems.includes("sidebarView")
    ? pageSlotHiddenClasses.withSwitch
    : pageSlotHiddenClasses.withoutSwitch;

  return pinnedItems.filter(isNavPageId).map((page, index) => {
    const Icon = navPageIcons[page];
    const label = navPageLabels[page];

    return (
      <Button
        key={page}
        variant="flat"
        className={cn(
          "h-full w-8 shrink-0 px-0",
          hiddenClasses[index],
          mainView === page && "bg-white/8 text-zinc-100",
        )}
        onClick={() => toggleView(page)}
        aria-label={label}
        aria-pressed={mainView === page}
        title={label}
      >
        <Icon className="size-3.5" />
      </Button>
    );
  });
}

function PinButton({
  item,
  itemLabel,
  pinned,
}: {
  item: PinnableItemId;
  itemLabel: string;
  pinned: boolean;
}) {
  const setHeaderItemPinned = useMutation(
    orpc.appSettings.setHeaderItemPinned.mutationOptions(),
  );
  const label = pinned
    ? `Unpin ${itemLabel} from the sidebar header`
    : `Pin ${itemLabel} to the sidebar header`;

  return (
    <button
      type="button"
      className={cn(
        "-mr-1 ml-auto flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-white/8 hover:text-foreground",
        pinned
          ? "text-foreground"
          : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[highlighted]:opacity-100",
      )}
      onClick={(event) => {
        event.stopPropagation();
        setHeaderItemPinned.mutate({ item, pinned: !pinned });
      }}
      aria-label={label}
      aria-pressed={pinned}
      title={label}
    >
      {pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
    </button>
  );
}

function SidebarViewMenuItem() {
  const sidebarView = useAppState((state) => state.appSettings.sidebarView);
  const pinned = useItemPinned("sidebarView");
  const setSidebarView = useMutation(
    orpc.appSettings.setSidebarView.mutationOptions(),
  );

  const isInbox = sidebarView === "inbox";

  return (
    <DropdownMenuItem
      className="group pr-1"
      onClick={() => {
        setSidebarView.mutate({ view: isInbox ? "projects" : "inbox" });
      }}
    >
      {isInbox ? (
        <ListTree className="size-3.5" />
      ) : (
        <Inbox className="size-3.5" />
      )}
      {isInbox ? "Switch to project view" : "Switch to inbox view"}
      <PinButton
        item="sidebarView"
        itemLabel="the sidebar switch"
        pinned={pinned}
      />
    </DropdownMenuItem>
  );
}

export function SidebarNavMenuItems({ children }: { children?: ReactNode }) {
  const openSettingsDialog = useSettingsStore((x) => x.openSettingsDialog);
  const toggleView = useMainViewStore((state) => state.toggleView);
  const pinnedItems = usePinnedItems();

  return (
    <>
      <SidebarViewMenuItem />
      <DropdownMenuSeparator />
      {navPageIds.map((page) => {
        const Icon = navPageIcons[page];

        return (
          <DropdownMenuItem
            key={page}
            className="group pr-1"
            onClick={() => toggleView(page)}
          >
            <Icon className="size-3.5" />
            {navPageLabels[page]}
            <PinButton
              item={page}
              itemLabel={navPageLabels[page]}
              pinned={pinnedItems.includes(page)}
            />
          </DropdownMenuItem>
        );
      })}
      {children}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={openSettingsDialog}>
        <Settings className="size-3.5" />
        Settings
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => window.location.reload()}>
        <RefreshCw className="size-3.5" />
        Reload app
      </DropdownMenuItem>
    </>
  );
}
