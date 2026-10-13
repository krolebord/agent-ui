import type { AgentBrowserState } from "@main/visuals/agent-browser-service";

export const AGENT_BROWSER_INSTALL_URL =
  "https://agent-browser.dev/installation";

export function describeAgentBrowserStatus(state: AgentBrowserState): string {
  switch (state.status) {
    case "checking":
      return "Checking for agent-browser…";
    case "available":
      return `agent-browser ${state.version} available`;
    case "unavailable":
      return `Not available: ${state.error}`;
  }
}
