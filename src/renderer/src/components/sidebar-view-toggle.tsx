import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@renderer/components/ui/dropdown-menu";
import { useMainViewStore } from "@renderer/hooks/use-main-view";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import { useMutation } from "@tanstack/react-query";
import {
  CalendarClock,
  Inbox,
  ListTree,
  PackageOpen,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";
import { useSettingsStore } from "./settings-dialog";
import { useAppState } from "./sync-state-provider";

/**
 * Flips the sidebar between the project tree and the flat inbox. An icon button
 * rather than a segmented control: the header is a 36px strip of w-9 icon
 * buttons, and a two-segment control would either crowd the drag region or
 * force the strip taller.
 */
export function SidebarViewToggle() {
  const sidebarView = useAppState((state) => state.appSettings.sidebarView);
  const setSidebarView = useMutation(
    orpc.appSettings.setSidebarView.mutationOptions(),
  );

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

/**
 * The main-view entries shared by both sidebars' overflow menus, so switching
 * sidebars never costs you access to skills, schedules, accounts or settings.
 */
export function SidebarNavMenuItems() {
  const openSettingsDialog = useSettingsStore((x) => x.openSettingsDialog);
  const toggleSkills = useMainViewStore((state) => state.toggleSkills);
  const toggleScheduledSessions = useMainViewStore(
    (state) => state.toggleScheduledSessions,
  );
  const toggleAccounts = useMainViewStore((state) => state.toggleAccounts);
  const toggleArtifacts = useMainViewStore((state) => state.toggleArtifacts);

  return (
    <>
      <DropdownMenuItem onClick={toggleSkills}>
        <Sparkles className="size-3.5" />
        Skills
      </DropdownMenuItem>
      <DropdownMenuItem onClick={toggleScheduledSessions}>
        <CalendarClock className="size-3.5" />
        Scheduled sessions
      </DropdownMenuItem>
      <DropdownMenuItem onClick={toggleAccounts}>
        <Users className="size-3.5" />
        Accounts
      </DropdownMenuItem>
      <DropdownMenuItem onClick={toggleArtifacts}>
        <PackageOpen className="size-3.5" />
        Artifacts
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={openSettingsDialog}>
        <Settings className="size-3.5" />
        Settings
      </DropdownMenuItem>
    </>
  );
}
