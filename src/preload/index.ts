import { contextBridge, ipcRenderer } from "electron";
import {
  type AddClaudeProjectInput,
  CLAUDE_IPC_CHANNELS,
  type ClaudeActiveSessionChangedEvent,
  type ClaudeDesktopApi,
  type ClaudeSessionDataEvent,
  type ClaudeSessionErrorEvent,
  type ClaudeSessionExitEvent,
  type ClaudeSessionUpdatedEvent,
  type ClaudeSessionsSnapshot,
  type ClaudeUsageResult,
  type DeleteClaudeProjectInput,
  type DeleteClaudeSessionInput,
  type ResizeClaudeSessionInput,
  type SetActiveSessionInput,
  type SetClaudeProjectCollapsedInput,
  type SetClaudeProjectDefaultsInput,
  type StartClaudeSessionInput,
  type StartClaudeSessionResult,
  type StopClaudeSessionInput,
  type WriteClaudeSessionInput,
} from "../shared/claude-types";

function subscribe<T>(
  channel: string,
  callback: (payload: T) => void,
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => {
    callback(payload);
  };

  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.off(channel, listener);
  };
}

const claudeApi: ClaudeDesktopApi = {
  selectFolder: () => ipcRenderer.invoke(CLAUDE_IPC_CHANNELS.selectFolder),
  getSessions: (): Promise<ClaudeSessionsSnapshot> =>
    ipcRenderer.invoke(CLAUDE_IPC_CHANNELS.getSessions),
  addClaudeProject: (
    input: AddClaudeProjectInput,
  ): Promise<ClaudeSessionsSnapshot> =>
    ipcRenderer.invoke(CLAUDE_IPC_CHANNELS.addProject, input),
  setClaudeProjectCollapsed: (
    input: SetClaudeProjectCollapsedInput,
  ): Promise<ClaudeSessionsSnapshot> =>
    ipcRenderer.invoke(CLAUDE_IPC_CHANNELS.setProjectCollapsed, input),
  setClaudeProjectDefaults: (
    input: SetClaudeProjectDefaultsInput,
  ): Promise<ClaudeSessionsSnapshot> =>
    ipcRenderer.invoke(CLAUDE_IPC_CHANNELS.setProjectDefaults, input),
  deleteClaudeProject: (
    input: DeleteClaudeProjectInput,
  ): Promise<ClaudeSessionsSnapshot> =>
    ipcRenderer.invoke(CLAUDE_IPC_CHANNELS.deleteProject, input),
  startClaudeSession: (
    input: StartClaudeSessionInput,
  ): Promise<StartClaudeSessionResult> =>
    ipcRenderer.invoke(CLAUDE_IPC_CHANNELS.startSession, input),
  stopClaudeSession: (input: StopClaudeSessionInput): Promise<void> =>
    ipcRenderer.invoke(CLAUDE_IPC_CHANNELS.stopSession, input),
  deleteClaudeSession: (input: DeleteClaudeSessionInput): Promise<void> =>
    ipcRenderer.invoke(CLAUDE_IPC_CHANNELS.deleteSession, input),
  setActiveSession: (input: SetActiveSessionInput): Promise<void> =>
    ipcRenderer.invoke(CLAUDE_IPC_CHANNELS.setActiveSession, input),
  writeToClaudeSession: (input: WriteClaudeSessionInput): void => {
    ipcRenderer.send(CLAUDE_IPC_CHANNELS.writeSession, input);
  },
  resizeClaudeSession: (input: ResizeClaudeSessionInput): void => {
    ipcRenderer.send(CLAUDE_IPC_CHANNELS.resizeSession, input);
  },
  onClaudeSessionData: (callback) =>
    subscribe<ClaudeSessionDataEvent>(
      CLAUDE_IPC_CHANNELS.sessionData,
      callback,
    ),
  onClaudeSessionExit: (callback) =>
    subscribe<ClaudeSessionExitEvent>(
      CLAUDE_IPC_CHANNELS.sessionExit,
      callback,
    ),
  onClaudeSessionError: (callback) =>
    subscribe<ClaudeSessionErrorEvent>(
      CLAUDE_IPC_CHANNELS.sessionError,
      callback,
    ),
  onClaudeSessionUpdated: (callback) =>
    subscribe<ClaudeSessionUpdatedEvent>(
      CLAUDE_IPC_CHANNELS.sessionUpdated,
      callback,
    ),
  onClaudeActiveSessionChanged: (callback) =>
    subscribe<ClaudeActiveSessionChangedEvent>(
      CLAUDE_IPC_CHANNELS.activeSessionChanged,
      callback,
    ),
  getUsage: (): Promise<ClaudeUsageResult> =>
    ipcRenderer.invoke(CLAUDE_IPC_CHANNELS.getUsage),
  openLogFolder: (): Promise<void> =>
    ipcRenderer.invoke(CLAUDE_IPC_CHANNELS.openLogFolder),
};

contextBridge.exposeInMainWorld("claude", claudeApi);
