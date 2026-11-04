import type { AppConfig, Paths } from "./config.js";
import type { FileLockManager } from "./locks.js";
import type { PluginService } from "./plugins.js";
import type { McpService } from "./mcp.js";
import type { RoleService } from "./roles.js";
import type { ProjectIndexer } from "./indexer.js";
import type { SkillService } from "./skills.js";
import type { AppStore, ProjectRecord, TaskRecord } from "./store.js";
import type { Approval, ApprovalKind, RuntimeEvent } from "@yuanfang/shared";
import type { ConversationId } from "@earendil-works/pi-durable";

export interface AgentScope {
  kind: "system" | "project" | "role";
  conversationId: string;
  project: ProjectRecord | undefined;
  task: TaskRecord | undefined;
}

export interface MessageOptions {
  entryKind?: string;
  meta?: Record<string, unknown>;
  requestId?: string;
  /** Internal reports may reach a paused/archived project so a running task can finish cleanly. */
  internal?: boolean;
  displayRole?: "user" | "event";
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  brief: string;
  role?: string;
  files?: string[];
  dependsOn?: string[];
}

export interface RuntimeHost {
  readonly paths: Paths;
  readonly store: AppStore;
  readonly locks: FileLockManager;
  readonly skills: SkillService;
  readonly plugins: PluginService;
  readonly mcp: McpService;
  readonly roles: RoleService;
  readonly indexer: ProjectIndexer;

  getConfig(): AppConfig;
  scopeFor(conversationId: ConversationId | string): AgentScope;
  notify(event: RuntimeEvent): void;
  log(level: "info" | "warn" | "error", message: string): void;

  createProject(input: { name: string; brief: string; path?: string }): Promise<ProjectRecord>;
  ensureProjectConversation(projectId: string): Promise<string>;
  messageProject(projectId: string, text: string, options?: MessageOptions): Promise<void>;
  messageSystem(text: string, options?: MessageOptions): Promise<void>;
  indexProject(projectId: string): Promise<number>;
  createTask(input: CreateTaskInput): TaskRecord;
  createApproval(input: {
    kind: ApprovalKind;
    title: string;
    detail: string;
    payload?: Record<string, unknown>;
    projectId?: string | null;
    taskId?: string | null;
    conversationId?: string | null;
    requestedBy?: string;
  }): Approval;
  dispatchTask(taskId: string): Promise<{ reporterId: string; roleConversationId: string }>;
  cancelTask(taskId: string): Promise<void>;
  reportTaskProgress(taskId: string, progress: string): void;
  acceptTask(taskId: string, note?: string): void;
  updateMemory(id: string, change: { title?: string; body?: string; tags?: string[]; pinned?: boolean }): import("@yuanfang/shared").MemoryEntry | undefined;
  deleteMemory(id: string): boolean;
  rejectTask(taskId: string, note: string): void;
  retryTask(taskId: string): Promise<{ reporterId: string; roleConversationId: string }>;
  abortConversation(conversationId: string): Promise<void>;
  acquireTaskClaims(taskId: string, files: string[], signal?: AbortSignal): Promise<void>;
  releaseTaskClaims(taskId: string): void;
  scheduleProjectIndex(projectId: string): void;
  reloadPlugins(): Promise<void>;
  removePlugin(name: string): Promise<boolean>;
  removeSkill(name: string, scope: "global" | "project", projectId?: string | null): Promise<boolean>;
}
