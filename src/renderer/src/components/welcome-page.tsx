import { FolderPlus, MessageSquarePlus } from "lucide-react";

export function WelcomePage({
  hasProjects = false,
}: {
  hasProjects?: boolean;
}) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md space-y-6 text-center">
        <h1 className="text-2xl font-semibold text-zinc-100">Agent UI</h1>
        <p className="text-sm leading-relaxed text-zinc-400">
          {hasProjects
            ? "Select a session from the sidebar or start a new one to keep working."
            : "Add a project from the sidebar, then start a new session to begin working with Claude."}
        </p>
        <div className="flex flex-col gap-3 text-left text-sm text-zinc-500">
          <div className="flex items-start gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3">
            <FolderPlus className="mt-0.5 size-4 shrink-0 text-zinc-400" />
            <span>
              {hasProjects ? (
                <>
                  Choose a project in the sidebar to inspect its sessions and
                  terminals
                </>
              ) : (
                <>
                  Click{" "}
                  <strong className="text-zinc-300">Add new project</strong> to
                  register a working directory
                </>
              )}
            </span>
          </div>
          <div className="flex items-start gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3">
            <MessageSquarePlus className="mt-0.5 size-4 shrink-0 text-zinc-400" />
            <span>
              {hasProjects ? (
                <>
                  Use the <strong className="text-zinc-300">+</strong> button on
                  a project to start another session
                </>
              ) : (
                <>
                  Then use the <strong className="text-zinc-300">+</strong>{" "}
                  button on a project to start a Claude session
                </>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
