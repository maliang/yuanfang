import { contextBridge, ipcRenderer } from "electron";
import type { RuntimeEvent, NavigateInput } from "@yuanfang/shared";
import { IPC } from "./channels";

const api = {
  getStatus: () => ipcRenderer.invoke(IPC.getStatus),
  getProjects: () => ipcRenderer.invoke(IPC.getProjects),
  getProject: (projectId: string) => ipcRenderer.invoke(IPC.getProject, projectId),
  createProject: (input: unknown) => ipcRenderer.invoke(IPC.createProject, input),
  updateProject: (input: { projectId: string; status: string }) => ipcRenderer.invoke(IPC.updateProject, input),
  archiveProject: (input: { projectId: string; status: string }) => ipcRenderer.invoke(IPC.archiveProject, input),
  deleteProject: (projectId: string) => ipcRenderer.invoke(IPC.deleteProject, projectId),
  createTask: (input: unknown) => ipcRenderer.invoke(IPC.createTask, input),
  dispatchTask: (taskId: string) => ipcRenderer.invoke(IPC.dispatchTask, taskId),
  cancelTask: (taskId: string) => ipcRenderer.invoke(IPC.cancelTask, taskId),
  acceptTask: (input: { taskId: string; note?: string }) => ipcRenderer.invoke(IPC.acceptTask, input),
  rejectTask: (input: { taskId: string; note: string }) => ipcRenderer.invoke(IPC.rejectTask, input),
  retryTask: (taskId: string) => ipcRenderer.invoke(IPC.retryTask, taskId),
  abortConversation: (conversationId: string) => ipcRenderer.invoke(IPC.abortConversation, conversationId),
  getTasks: (projectId: string) => ipcRenderer.invoke(IPC.getTasks, projectId),
  getTaskEvents: (taskId: string) => ipcRenderer.invoke(IPC.getTaskEvents, taskId),
  indexProject: (projectId: string) => ipcRenderer.invoke(IPC.indexProject, projectId),
  sendChat: (input: { projectId?: string | null; text: string }) => ipcRenderer.invoke(IPC.sendChat, input),
  getConversation: (conversationId: string) => ipcRenderer.invoke(IPC.getConversation, conversationId),
  getSystemConversation: () => ipcRenderer.invoke(IPC.getSystemConversation),
  getApprovals: (input?: { status?: string }) => ipcRenderer.invoke(IPC.getApprovals, input),
  getNotifications: () => ipcRenderer.invoke(IPC.getNotifications),
  markNotificationsRead: () => ipcRenderer.invoke(IPC.markNotificationsRead),
  resolveApproval: (input: { id: string; decision: "approved" | "denied"; note: string | null }) =>
    ipcRenderer.invoke(IPC.resolveApproval, input),
  getMemories: (input?: { projectId?: string | null }) => ipcRenderer.invoke(IPC.getMemories, input),
  addMemory: (input: unknown) => ipcRenderer.invoke(IPC.addMemory, input),
  updateMemory: (input: unknown) => ipcRenderer.invoke(IPC.updateMemory, input),
  deleteMemory: (id: string) => ipcRenderer.invoke(IPC.deleteMemory, id),
  search: (input: { query: string; projectId?: string | null }) => ipcRenderer.invoke(IPC.search, input),
  getConfig: () => ipcRenderer.invoke(IPC.getConfig),
  getProviders: () => ipcRenderer.invoke(IPC.getProviders),
  getProviderModels: (input: { providerId: string; refresh?: boolean }) =>
    ipcRenderer.invoke(IPC.getProviderModels, input),
  saveProviderKey: (input: { providerId: string; key: string; env?: Record<string, string> }) =>
    ipcRenderer.invoke(IPC.saveProviderKey, input),
  removeProviderKey: (providerId: string) => ipcRenderer.invoke(IPC.removeProviderKey, providerId),
  updateConfig: (input: unknown) => ipcRenderer.invoke(IPC.updateConfig, input),
  getSkills: (input?: { projectId?: string | null }) => ipcRenderer.invoke(IPC.getSkills, input),
  saveSkill: (input: unknown) => ipcRenderer.invoke(IPC.saveSkill, input),
  readSkill: (input: { name: string; projectId?: string | null }) => ipcRenderer.invoke(IPC.readSkill, input),
  getPlugins: () => ipcRenderer.invoke(IPC.getPlugins),
  getMcpServers: () => ipcRenderer.invoke(IPC.getMcpServers),
  removeMcpServer: (name: string) => ipcRenderer.invoke(IPC.removeMcpServer, name),
  reloadPlugins: () => ipcRenderer.invoke(IPC.reloadPlugins),
  removePlugin: (name: string) => ipcRenderer.invoke(IPC.removePlugin, name),
  deleteSkill: (input: { name: string; scope: "global" | "project"; projectId?: string | null }) =>
    ipcRenderer.invoke(IPC.deleteSkill, input),
  getLocks: () => ipcRenderer.invoke(IPC.getLocks),
  openWorkspace: (path: string) => ipcRenderer.invoke(IPC.openWorkspace, path),
  quickAsk: (text: string) => ipcRenderer.invoke(IPC.quickAsk, { text }),
  hideQuickAsk: () => ipcRenderer.send(IPC.hideQuickAsk),
  openMain: () => ipcRenderer.send(IPC.openMain),
  onEvent: (callback: (event: RuntimeEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: RuntimeEvent) => callback(payload);
    ipcRenderer.on(IPC.event, handler);
    return () => ipcRenderer.removeListener(IPC.event, handler);
  },
  onNavigate: (callback: (target: NavigateInput) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: NavigateInput) => callback(payload);
    ipcRenderer.on(IPC.navigate, handler);
    return () => ipcRenderer.removeListener(IPC.navigate, handler);
  },
};

contextBridge.exposeInMainWorld("yuanfang", api);

export type YuanfangApi = typeof api;
