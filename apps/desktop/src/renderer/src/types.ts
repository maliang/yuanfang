import type {
  Approval,
  ChatMessage,
  ConversationFeed,
  FileLockInfo,
  MemoryEntry,
  NavigateInput,
  PluginInfo,
  ProjectDetail,
  ProjectStatus,
  ProjectSummary,
  RuntimeConfigView,
  RuntimeEvent,
  RuntimeStatus,
  SearchHit,
  SkillInfo,
  TaskSummary,
  UpdateConfigInput,
} from "@yuanfang/shared";

export interface YuanfangApi {
  getStatus(): Promise<RuntimeStatus>;
  getProjects(): Promise<ProjectSummary[]>;
  getProject(projectId: string): Promise<ProjectDetail | undefined>;
  createProject(input: { name: string; brief: string; path?: string }): Promise<ProjectSummary>;
  updateProject(input: { projectId: string; status: ProjectStatus }): Promise<ProjectSummary | undefined>;
  archiveProject(input: { projectId: string; status: ProjectStatus }): Promise<ProjectSummary | undefined>;
  deleteProject(projectId: string): Promise<boolean>;
  createTask(input: {
    projectId: string;
    title: string;
    brief: string;
    role?: string;
    files?: string[];
    dependsOn?: string[];
    stage?: string;
  }): Promise<TaskSummary>;
  dispatchTask(taskId: string): Promise<{ reporterId: string; roleConversationId: string }>;
  cancelTask(taskId: string): Promise<void>;
  acceptTask(input: { taskId: string; note?: string }): Promise<void>;
  rejectTask(input: { taskId: string; note: string }): Promise<void>;
  retryTask(taskId: string): Promise<{ reporterId: string; roleConversationId: string }>;
  abortConversation(conversationId: string): Promise<void>;
  getTasks(projectId: string): Promise<TaskSummary[]>;
  getTaskEvents(taskId: string): Promise<import("@yuanfang/shared").TaskEvent[]>;
  indexProject(projectId: string): Promise<number>;
  sendChat(input: { projectId?: string | null; text: string }): Promise<{ conversationId: string; messageId: number }>;
  getConversation(conversationId: string): Promise<ConversationFeed>;
  getSystemConversation(): Promise<{ conversationId: string; feed: ConversationFeed }>;
  getApprovals(input?: { status?: string }): Promise<Approval[]>;
  getNotifications(): Promise<import("@yuanfang/shared").NotificationRecord[]>;
  markNotificationsRead(): Promise<void>;
  resolveApproval(input: { id: string; decision: "approved" | "denied"; note: string | null }): Promise<Approval | undefined>;
  getMemories(input?: { projectId?: string | null }): Promise<MemoryEntry[]>;
  updateMemory(input: {
    id: string;
    change: { title?: string; body?: string; tags?: string[]; pinned?: boolean };
  }): Promise<MemoryEntry | undefined>;
  deleteMemory(id: string): Promise<boolean>;
  addMemory(input: {
    scope: string;
    kind: string;
    title: string;
    body: string;
    tags?: string[];
    pinned?: boolean;
  }): Promise<MemoryEntry>;
  search(input: { query: string; projectId?: string | null }): Promise<SearchHit[]>;
  getConfig(): Promise<RuntimeConfigView>;
  getProviders(): Promise<import("@yuanfang/shared").ProviderView[]>;
  getProviderModels(input: {
    providerId: string;
    refresh?: boolean;
  }): Promise<import("@yuanfang/shared").ProviderModelsResult>;
  saveProviderKey(input: {
    providerId: string;
    key: string;
    env?: Record<string, string>;
  }): Promise<import("@yuanfang/shared").ProviderModelsResult>;
  removeProviderKey(providerId: string): Promise<import("@yuanfang/shared").ProviderModelsResult>;
  importPiCredentials(): Promise<number>;
  getRoles(): Promise<import("@yuanfang/shared").RoleDefinitionView[]>;
  saveRole(input: {
    name: string;
    description: string;
    instructions: string;
    model: { provider: string; modelId: string } | null;
  }): Promise<import("@yuanfang/shared").RoleDefinitionView[]>;
  beginProviderLogin(providerId: string): Promise<{ loginId: string }>;
  respondLoginPrompt(input: { loginId: string; promptId: string; value: string }): Promise<void>;
  cancelProviderLogin(loginId: string): Promise<void>;
  updateConfig(input: UpdateConfigInput): Promise<RuntimeConfigView>;
  getSkills(input?: { projectId?: string | null }): Promise<SkillInfo[]>;
  saveSkill(input: {
    name: string;
    description: string;
    body: string;
    scope?: "global" | "project";
    projectId?: string | null;
  }): Promise<SkillInfo>;
  readSkill(input: { name: string; projectId?: string | null }): Promise<{
    name: string;
    description: string;
    content: string;
    scope: string;
    path: string;
  } | null>;
  getPlugins(): Promise<PluginInfo[]>;
  removePlugin(name: string): Promise<boolean>;
  deleteSkill(input: { name: string; scope: "global" | "project"; projectId?: string | null }): Promise<boolean>;
  getMcpServers(): Promise<Array<{
    name: string;
    command: string;
    args: string[];
    url: string | null;
    oauth: boolean;
    projects: string[];
    connected: boolean;
    tools: Array<{ name: string; description: string }>;
    error: string | null;
  }>>;
  removeMcpServer(name: string): Promise<boolean>;
  reloadPlugins(): Promise<void>;
  getLocks(): Promise<FileLockInfo[]>;
  openWorkspace(path: string): Promise<void>;
  quickAsk(text: string): Promise<{ conversationId: string; messageId: number }>;
  hideQuickAsk(): void;
  openMain(): void;
  checkForUpdates(): Promise<void>;
  onEvent(callback: (event: RuntimeEvent) => void): () => void;
  onNavigate(callback: (target: NavigateInput) => void): () => void;
}

declare global {
  interface Window {
    yuanfang: YuanfangApi;
  }
}

export type { ChatMessage, ConversationFeed };
