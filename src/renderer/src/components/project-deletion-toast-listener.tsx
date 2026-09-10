import { useAppState } from "@renderer/components/sync-state-provider";
import { orpc } from "@renderer/orpc-client";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

export function ProjectDeletionToastListener() {
  const projects = useAppState((s) => s.projects);
  const shownKeysRef = useRef(new Set<string>());

  useEffect(() => {
    const paths = new Set(projects.map((p) => p.path));
    for (const key of [...shownKeysRef.current]) {
      const path = key.split("\0")[0];
      if (!paths.has(path)) {
        shownKeysRef.current.delete(key);
      }
    }

    for (const project of projects) {
      const t = project.deletionToast;
      if (!t) {
        continue;
      }
      const key = `${project.path}\0${t.kind}\0${t.message}`;
      if (shownKeysRef.current.has(key)) {
        continue;
      }
      shownKeysRef.current.add(key);
      if (t.kind === "warning") {
        toast.warning(t.message);
      } else {
        toast.error(t.message);
      }
      void orpc.projects.ackDeletionToast.call({ path: project.path });
    }
  }, [projects]);

  return null;
}
