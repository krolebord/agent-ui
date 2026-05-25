import {
  ProjectDiffPane,
  useProjectBottomPaneView,
} from "@renderer/components/diff-review-pane";
import { ProjectTerminalPane } from "@renderer/components/project-terminal-pane";

export function ProjectBottomPane({ cwd }: { cwd: string | null }) {
  const view = useProjectBottomPaneView(cwd);

  if (!cwd || view === "terminals") {
    return <ProjectTerminalPane cwd={cwd} />;
  }

  return <ProjectDiffPane cwd={cwd} />;
}
