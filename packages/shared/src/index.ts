/**
 * Types shared by the Yuanfang core runtime and its desktop client.
 *
 * Everything here must stay serializable: it crosses an Electron IPC boundary.
 */

export type AgentKind = "system" | "project" | "role";

export type ThemeMode = "dark" | "light" | "system";

export type ProjectStatus = "active" | "paused" | "archived";

export type TaskStatus =
  | "todo"
  | "queued"
  | "running"
  | "waiting"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export type ApprovalKind = "shell" | "install" | "mcp" | "network" | "plugin" | "other";

export type MemoryKind = "note" | "decision" | "architecture" | "episode" | "preference";

export type ChatRole = "user" | "assistant" | "event";

export interface TokenStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** cacheRead / (input + cacheRead + cacheWrite), 0..1 */
  cacheHitRate: number;
  /** All tokens reported, including cache reads/writes. */
  totalTokens: number;
  /** Input + output only; what people usually mean by token usage. */
  billableTokens: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  brief: string;
  path: string;
  status: ProjectStatus;
  color: string;
  conversationId: string | null;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number;
  totalMs: number;
  stats: TokenStats;
  workflow: string[];
  taskCounts: Record<TaskStatus, number>;
  activeTaskCount: number;
  pendingApprovalCount: number;
}

export interface ProjectDetail extends ProjectSummary {
  readme: string;
  topLevel: string[];
  tasks: TaskSummary[];
  agents: AgentSummary[];
  memories: MemoryEntry[];
}

export interface TaskSummary {
  id: string;
  projectId: string;
  title: string;
  brief: string;
  role: string;
  status: TaskStatus;
  model: string | null;
  conversationId: string | null;
  durableTaskId: string | null;
  dependsOn: string[];
  files: string[];
  stage: string;
  worktreePath: string | null;
  worktreeBranch: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number;
  stats: TokenStats;
  progress: string | null;
  error: string | null;
  result: string | null;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  callId: string;
  name: string;
  status: "running" | "done" | "error";
  output: string | null;
  details: string | null;
  createdAt: number;
}

export interface AgentSummary {
  id: string;
  kind: AgentKind;
  name: string;
  conversationId: string | null;
  projectId: string | null;
  model: string | null;
  busy: boolean;
  lastActiveAt: number;
}

export interface MemoryEntry {
  id: string;
  scope: string;
  kind: MemoryKind;
  title: string;
  body: string;
  tags: string[];
  source: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LoginPromptView {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}

export type LoginEventView =
  | { type: "info"; message: string; links?: Array<{ url: string; label?: string }> }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      openBrowserOnConfirm?: boolean;
      copyCodeOnConfirm?: boolean;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export interface NotificationRecord {
  id: number;
  title: string;
  body: string;
  projectId: string | null;
  taskId: string | null;
  conversationId: string | null;
  messageId: number | null;
  important: boolean;
  read: boolean;
  createdAt: number;
}

export interface ChatMessage {
  id: number;
  conversationId: string;
  agentKind: AgentKind;
  projectId: string | null;
  role: ChatRole;
  content: string;
  createdAt: number;
  meta: Record<string, unknown> | null;
}

export interface Approval {
  id: string;
  kind: ApprovalKind;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  projectId: string | null;
  taskId: string | null;
  conversationId: string | null;
  requestedBy: string;
  createdAt: number;
  resolvedAt: number | null;
  resolutionNote: string | null;
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  scope: "global" | "project";
  projectId: string | null;
  updatedAt: number;
}

export interface PluginInfo {
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  loaded: boolean;
  error: string | null;
  updatedAt: number;
  permissions: string[];
  sandboxed: boolean;
}

export interface FileIndexEntry {
  projectId: string;
  path: string;
  size: number;
  mtime: number;
  language: string;
  summary: string;
}

export interface FileLockInfo {
  path: string;
  owner: string;
  projectId: string | null;
  acquiredAt: number;
}

export interface RoleDefinitionView {
  name: string;
  description: string;
  instructions: string;
  model: { provider: string; modelId: string } | null;
}

export interface ProviderView {
  id: string;
  name: string;
  apiKeyName: string | null;
  oauthName: string | null;
  configured: boolean;
  source: string | null;
  origin: "yuanfang" | "pi" | "env" | "none";
  modelCount: number;
}

export interface ProviderModelsResult {
  provider: ProviderView;
  models: ModelOption[];
  errors: string[];
}

export interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
  contextWindow: number;
  supportsImages: boolean;
  inputCost: number;
  outputCost: number;
}

export interface RuntimeConfigView {
  workspace: string;
  agentName: string;
  projectsDir: string;
  provider: string;
  model: string;
  projectProvider: string;
  projectModel: string;
  roleProvider: string;
  roleModel: string;
  thinkingLevel: string;
  roleThinkingLevel: string;
  maxTurns: number;
  maxConcurrentTasks: number;
  notifyLevel: "all" | "important" | "off";
  worktreePerTask: boolean;
  dailyTokenBudget: number;
  updateFeedUrl: string;
  quickAskHotkey: string;
  theme: ThemeMode;
  uiScale: number;
  persona: string;
  personaPath: string;
  defaultProjectDir: string;
  availableModels: ModelOption[];
}

export interface UpdateConfigInput {
  agentName?: string;
  provider?: string;
  model?: string;
  projectProvider?: string;
  projectModel?: string;
  roleProvider?: string;
  roleModel?: string;
  thinkingLevel?: string;
  roleThinkingLevel?: string;
  maxTurns?: number;
  maxConcurrentTasks?: number;
  notifyLevel?: "all" | "important" | "off";
  worktreePerTask?: boolean;
  dailyTokenBudget?: number;
  updateFeedUrl?: string;
  quickAskHotkey?: string;
  theme?: ThemeMode;
  uiScale?: number;
  persona?: string;
}

export interface RuntimeStatus {
  ready: boolean;
  booting: boolean;
  error: string | null;
  warning: string | null;
  workspace: string;
  startedAt: number;
  activeRuns: number;
  pendingApprovals: number;
  runningTasks: number;
  quickAskHotkey: string;
}

export interface AddProjectInput {
  name: string;
  brief: string;
  path?: string;
}

export interface DraftProjectBriefInput {
  name: string;
  path?: string;
}

export interface AppInfoView {
  version: string;
  packaged: boolean;
  updateFeedUrl: string;
}

export interface DraftProjectBriefResult {
  brief: string;
  fileCount: number;
  existing: boolean;
  ai: boolean;
  warning: string | null;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  brief: string;
  role?: string;
  files?: string[];
  dependsOn?: string[];
  stage?: string;
}

export interface SearchHit {
  kind: "memory" | "file";
  title: string;
  snippet: string;
  score: number;
  projectId: string | null;
  ref: string;
}

export interface ChatSendInput {
  projectId?: string | null;
  text: string;
}

export interface ChatSendResult {
  conversationId: string;
  messageId: number;
}

export type RuntimeEvent =
  | {
      type: "status";
      status: RuntimeStatus;
    }
  | {
      type: "agent_busy";
      conversationId: string;
      kind: AgentKind;
      projectId: string | null;
      busy: boolean;
    }
  | {
      type: "assistant_delta";
      conversationId: string;
      kind: AgentKind;
      projectId: string | null;
      text: string;
    }
  | {
      type: "assistant_message";
      message: ChatMessage;
    }
  | {
      type: "message_added";
      message: ChatMessage;
    }
  | {
      type: "tool";
      conversationId: string;
      callId: string;
      name: string;
      status: "running" | "done" | "error";
      output?: string;
    }
  | {
      type: "project_updated";
      project: ProjectSummary;
    }
  | {
      type: "task_updated";
      task: TaskSummary;
    }
  | {
      type: "approval_updated";
      approval: Approval;
    }
  | {
      type: "notification";
      title: string;
      body: string;
      projectId: string | null;
      taskId: string | null;
      conversationId: string | null;
      urgent: boolean;
      approvalId?: string;
      important?: boolean;
      messageId?: number;
      notificationId?: number;
    }
  | {
      type: "locks";
      locks: FileLockInfo[];
    }
  | {
      type: "external_url";
      url: string;
    }
  | {
      type: "login_prompt";
      loginId: string;
      providerId: string;
      prompt: LoginPromptView;
    }
  | {
      type: "login_event";
      loginId: string;
      providerId: string;
      event: LoginEventView;
    }
  | {
      type: "login_done";
      loginId: string;
      providerId: string;
      ok: boolean;
      error?: string;
    }
  | {
      type: "log";
      level: "info" | "warn" | "error";
      message: string;
    };

export interface ConversationFeed {
  conversationId: string;
  kind: AgentKind;
  projectId: string | null;
  busy: boolean;
  messages: ChatMessage[];
  partial: string | null;
  tools: Array<{ callId: string; name: string; status: string; output?: string }>;
}

export const IPC = {
  // renderer -> main
  getStatus: "yf:getStatus",
  getProjects: "yf:getProjects",
  getProject: "yf:getProject",
  createProject: "yf:createProject",
  updateProject: "yf:updateProject",
  archiveProject: "yf:archiveProject",
  deleteProject: "yf:deleteProject",
  createTask: "yf:createTask",
  dispatchTask: "yf:dispatchTask",
  cancelTask: "yf:cancelTask",
  acceptTask: "yf:acceptTask",
  rejectTask: "yf:rejectTask",
  retryTask: "yf:retryTask",
  abortConversation: "yf:abortConversation",
  updateMemory: "yf:updateMemory",
  deleteMemory: "yf:deleteMemory",
  getMcpServers: "yf:getMcpServers",
  removeMcpServer: "yf:removeMcpServer",
  getTasks: "yf:getTasks",
  getTaskEvents: "yf:getTaskEvents",
  indexProject: "yf:indexProject",
  sendChat: "yf:sendChat",
  getConversation: "yf:getConversation",
  getSystemConversation: "yf:getSystemConversation",
  getApprovals: "yf:getApprovals",
  getNotifications: "yf:getNotifications",
  markNotificationsRead: "yf:markNotificationsRead",
  resolveApproval: "yf:resolveApproval",
  getMemories: "yf:getMemories",
  addMemory: "yf:addMemory",
  search: "yf:search",
  getConfig: "yf:getConfig",
  getProviders: "yf:getProviders",
  getProviderModels: "yf:getProviderModels",
  saveProviderKey: "yf:saveProviderKey",
  removeProviderKey: "yf:removeProviderKey",
  getRoles: "yf:getRoles",
  saveRole: "yf:saveRole",
  importPiCredentials: "yf:importPiCredentials",
  beginProviderLogin: "yf:beginProviderLogin",
  respondLoginPrompt: "yf:respondLoginPrompt",
  cancelProviderLogin: "yf:cancelProviderLogin",
  updateConfig: "yf:updateConfig",
  draftProjectBrief: "yf:draftProjectBrief",
  chooseFolder: "yf:chooseFolder",
  setZoom: "yf:setZoom",
  getAppInfo: "yf:getAppInfo",
  getSkills: "yf:getSkills",
  saveSkill: "yf:saveSkill",
  readSkill: "yf:readSkill",
  getPlugins: "yf:getPlugins",
  reloadPlugins: "yf:reloadPlugins",
  removePlugin: "yf:removePlugin",
  deleteSkill: "yf:deleteSkill",
  getLocks: "yf:getLocks",
  openWorkspace: "yf:openWorkspace",
  quickAsk: "yf:quickAsk",
  hideQuickAsk: "yf:hideQuickAsk",
  openMain: "yf:openMain",
  checkForUpdates: "yf:checkForUpdates",
  // main -> renderer
  event: "yf:event",
  navigate: "yf:navigate",
} as const;

export interface NavigateInput {
  view: "project" | "chat" | "approvals" | "memory" | "skills" | "settings" | "notifications";
  projectId?: string;
  taskId?: string;
  conversationId?: string;
  messageId?: number;
}
