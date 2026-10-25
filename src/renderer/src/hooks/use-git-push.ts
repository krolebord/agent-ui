import { useAppState } from "@renderer/components/sync-state-provider";
import { orpc } from "@renderer/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent } from "react";
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
  const refreshMutation = useMutation(
    orpc.projects.refreshProject.mutationOptions(),
  );
  const refreshUpstreamStats = useEffectEvent(() => {
    if (!projectPath || projectLocked) return;
    refreshMutation.mutate({ path: projectPath });
  });

  useEffect(() => {
    projectPath;
    refreshUpstreamStats();

    let wasUnfocused = false;
    const handleBlur = () => {
      wasUnfocused = true;
    };
    const handleFocus = () => {
      if (!wasUnfocused) return;
      wasUnfocused = false;
      refreshUpstreamStats();
    };

    window.addEventListener("blur", handleBlur);
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("focus", handleFocus);
    };
  }, [projectPath]);

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
