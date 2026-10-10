import { useAppState } from "@renderer/components/sync-state-provider";
import { orpc } from "@renderer/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export function useGitPush(projectPath: string) {
  const queryClient = useQueryClient();
  const activeProject = useAppState((state) =>
    state.projects.find((project) => project.path === projectPath),
  );
  const upstreamStats = activeProject?.gitUpstreamDiffStats;
  const hasUpstream = Boolean(upstreamStats);
  const aheadCommits = upstreamStats?.aheadCommits ?? 0;
  const projectLocked = activeProject?.interactionDisabled === true;
  const mutation = useMutation(
    orpc.projects.pushToRemote.mutationOptions({
      onSuccess: () => {
        toast.success(
          upstreamStats
            ? `Pushed to ${upstreamStats.upstreamBranch}`
            : "Branch published to remote",
        );
        void queryClient.invalidateQueries({
          queryKey: orpc.projects.getCommitHistory.key(),
        });
      },
      onError: (error) => {
        toast.error(
          error instanceof Error && error.message.trim()
            ? error.message
            : "Git push failed",
        );
      },
    }),
  );

  return {
    upstreamStats,
    hasUpstream,
    aheadCommits,
    projectLocked,
    isPending: mutation.isPending,
    push: () => mutation.mutate({ path: projectPath }),
    label: hasUpstream
      ? `Push${aheadCommits > 0 ? ` (${aheadCommits})` : ""}`
      : "Publish branch",
    title: upstreamStats
      ? `Push to ${upstreamStats.upstreamBranch}`
      : "Publish the current branch to origin",
  };
}
