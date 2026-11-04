import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  AssistantEntry,
  configure,
  createRegistry,
  defineDocFamily,
  defineExtension,
  Harness,
  InboxDoc,
  LiveDoc,
  UsageDoc,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type EntryId,
  type Submission,
  type LiveState,
  type Registry,
  type UsageState,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools, createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { Models } from "@earendil-works/pi-ai";
import type {
  AgentKind,
  Approval,
  ApprovalStatus,
  ChatMessage,
  ChatSendResult,
  FileLockInfo,
  ModelOption,
  ProjectDetail,
  RuntimeConfigView,
  RuntimeEvent,
  RuntimeStatus,
  SearchHit,
  TaskSummary,
  UpdateConfigInput,
} from "@yuanfang/shared";
import { loadConfig, readPersona, saveConfig, writePersona, type AppConfig, type Paths } from "./config.js";
import { openDatabase } from "./db.js";
import { LayeredFileCredentialStore } from "./credentials.js";
import { FileLockManager } from "./locks.js";
import { ProjectIndexer } from "./indexer.js";
import { SkillService } from "./skills.js";
import { PluginService } from "./plugins.js";
import { McpService } from "./mcp.js";
import { RoleService } from "./roles.js";
import {
  emptyStats,
  slugify,
  uid,
  AppStore,
  type ProjectRecord,
  type TaskRecord,
} from "./store.js";
import {
  projectHandoff,
  renderMemoryDigestSyncFor,
  roleInstructions,
  systemHandoff,
  type PromptDeps,
} from "./prompts.js";
import { createExtensionSet, type ExtensionSet } from "./tools.js";
import { createTaskDefinitions, type RoleRunInput } from "./task-defs.js";
import type { CreateTaskInput, MessageOptions, RuntimeHost } from "./host.js";

const execFileAsync = promisify(execFile);
const SYSTEM_CONTEXT = BACKGROUND_CONTEXT;

// Survives a crash between the durable dispatch commit and the business-row
// update, so reconcile can find the reporter even when it is already terminal.
const DispatchRegistry = defineDocFamily<{ reporterId: string; roleConversationId: string }, string>({
  kind: "yuanfang.dispatch",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ reporterId: "", roleConversationId: "" }),
  checkpointWhen: () => false,
});

export interface OpenOptions {
  workspace?: string;
  /** Tests can inject a Models collection (for example pi-ai's faux provider). */
  models?: Models;
  /** Skip loading ~/.yuanfang/plugins (tests). */
  skipPlugins?: boolean;
  now?: () => number;
}

interface SendSystemOptions {
  role?: "user" | "event";
  meta?: Record<string, unknown>;
  entryKind?: string;
}

interface WatchState {
  kind: AgentKind;
  projectId: string | null;
  busy: boolean;
  partial: string;
  seen: Set<string>;
  tools: Map<string, string>;
  lastAssistantText: string;
}

interface WatchedConversation {
  state: WatchState;
  stop: () => void;
}

export class YuanfangRuntime implements RuntimeHost {
  paths!: Paths;
  store!: AppStore;
  locks!: FileLockManager;
  skills!: SkillService;
  plugins!: PluginService;
  mcp!: McpService;
  roles!: RoleService;
  indexer!: ProjectIndexer;
  models!: Models;
  credentials!: LayeredFileCredentialStore;
  harness!: Harness;
  registry!: Registry;
  config!: AppConfig;

  #extensions!: ExtensionSet;
  #taskDefs!: ReturnType<typeof createTaskDefinitions>;
  #promptDeps!: PromptDeps;
  #systemId = "";
  #watched = new Map<string, WatchedConversation>();
  #listeners = new Set<(event: RuntimeEvent) => void>();
  #status: RuntimeStatus;
  #usageTimer: NodeJS.Timeout | undefined;
  #projectLocks = new Map<string, Promise<string>>();
  #closed = false;
  #taskClaims = new Map<string, () => void>();
  #indexTimers = new Map<string, NodeJS.Timeout>();

  private constructor() {
    this.#status = {
      ready: false,
      booting: true,
      error: null,
      warning: null,
      workspace: "",
      startedAt: Date.now(),
      activeRuns: 0,
      pendingApprovals: 0,
      runningTasks: 0,
      quickAskHotkey: "CommandOrControl+Shift+Space",
    };
  }

  static async open(options: OpenOptions = {}): Promise<YuanfangRuntime> {
    const runtime = new YuanfangRuntime();
    await runtime.#init(options);
    return runtime;
  }

  async #init(options: OpenOptions): Promise<void> {
    const { config, paths } = await loadConfig(options.workspace);
    this.config = config;
    this.paths = paths;
    this.#status = { ...this.#status, workspace: paths.workspace };

    this.store = new AppStore(openDatabase(paths.database), options.now ?? Date.now);
    this.indexer = new ProjectIndexer();
    this.skills = new SkillService(paths.skillsDir);
    this.credentials = new LayeredFileCredentialStore(paths.yuanfangAuthFile, paths.piAuthFile);
    this.models = options.models ?? builtinModels({ credentials: this.credentials });
    this.registry = createRegistry();
    this.locks = new FileLockManager(() => paths.projectsDir, options.now ?? Date.now);

    this.#promptDeps = {
      paths,
      store: this.store,
      skills: this.skills,
      indexer: this.indexer,
      config: () => this.config,
      projectForConversation: (conversationId) => this.store.getProjectByConversation(conversationId)?.id ?? null,
    };

    this.#extensions = createExtensionSet(this, this.#promptDeps);
    this.registry.install(CodingTools);
    this.registry.install(this.#extensions.fileLocks);
    this.registry.install(this.#extensions.guard);
    this.registry.install(this.#extensions.shared);
    this.registry.install(this.#extensions.system);
    this.registry.install(this.#extensions.project);
    this.registry.install(this.#extensions.role);

    this.#taskDefs = createTaskDefinitions({
      host: this,
      syncUsage: (conversationId, projectId) => this.syncUsage(conversationId, projectId),
      answerText: (conversationId, answerId) => this.#answerText(conversationId, answerId),
    });
    this.registry.install(
      defineExtension({
        name: "yuanfang-tasks",
        tasks: [this.#taskDefs.Anchor, this.#taskDefs.RoleRun],
      }),
    );

    this.plugins = new PluginService(
      paths.pluginsDir,
      () => this.registry,
      () => ({ store: this.store, host: this, runtime: this }),
      (message) => this.log("info", message),
    );
    this.mcp = new McpService(
      paths.mcpFile,
      () => this.registry,
      (level, message) => this.log(level, message),
      (conversationId) => this.store.getProjectByConversation(conversationId)?.id ?? null,
    );
    this.roles = new RoleService(paths.rolesFile);

    this.harness = await Harness.open(
      await openNodeSqliteStorage(paths.harnessDatabase),
      {
        models: this.models,
        registry: this.registry,
        now: options.now,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? paths.workspace }),
        settings: {
          toolExecution: "parallel",
          compaction: { reserveTokens: 20_000, keepRecentTokens: 12_000, backgroundTokens: 8_000 },
          progress: { partialIntervalMs: 120, outputIntervalMs: 120, persistWithinMs: 800 },
          restartLimit: 8,
        },
        onReport: (report) => {
          const kind = report.kind;
          if (kind === "storage_failed") {
            this.log("error", `存储失败：${String(report.error)}`);
          } else if (kind === "task_faulted" || kind === "task_interrupted") {
            this.log("warn", `任务 ${kind}：${String(report.error)}`);
          }
        },
      },
      SYSTEM_CONTEXT,
    );
    this.harness.resume();

    this.locks.subscribe((locks) => this.#emit({ type: "locks", locks }));

    await this.#ensureSystemConversation();
    await this.#reconcileProjects();
    await this.#reconcileTasks();
    if (options.skipPlugins !== true) {
      await this.plugins.loadAll().catch((error: unknown) => {
        this.log("warn", `插件加载失败：${String(error)}`);
      });
      void this.mcp.loadAll().catch((error: unknown) => {
        this.log("warn", `MCP 加载失败：${String(error)}`);
      });
    }
    setImmediate(() => {
      void this.#resetSystemIfIdle().catch(() => undefined);
    });

    this.#usageTimer = setInterval(() => {
      void this.syncAllUsage().catch(() => undefined);
    }, 20_000);
    this.#usageTimer.unref?.();

    this.#status = {
      ...this.#status,
      ready: true,
      booting: false,
      pendingApprovals: this.store.countPendingApprovals(),
      runningTasks: this.store.listActiveTaskRecords().length,
    };
    this.#emit({ type: "status", status: this.#status });
    this.log("info", `${this.config.agentName}已就绪：${paths.workspace}`);
    this.#checkModelAuth();
  }

  // ── lifecycle / status ────────────────────────────────────────────────────

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  status(): RuntimeStatus {
    return {
      ...this.#status,
      activeRuns: [...this.#watched.values()].filter((watched) => watched.state.busy).length,
      pendingApprovals: this.store.countPendingApprovals(),
      runningTasks: this.store.listActiveTaskRecords().length,
    };
  }

  log(level: "info" | "warn" | "error", message: string): void {
    const prefix = this.config?.agentName ?? "元芳";
    if (level === "error") console.error(`[${prefix}] ${message}`);
    else if (level === "warn") console.warn(`[${prefix}] ${message}`);
    else console.log(`[${prefix}] ${message}`);
    this.#emit({ type: "log", level, message });
  }

  notify(event: RuntimeEvent): void {
    this.#notify(event);
  }

  #notify(event: RuntimeEvent): void {
    if (this.#closed) return;
    if (event.type !== "notification") {
      this.#emit(event);
      return;
    }
    const messageId =
      event.messageId ??
      (event.conversationId === null ? null : this.#lastAssistantMessageId(event.conversationId));
    const stored = this.store.addNotification({
      title: event.title,
      body: event.body,
      projectId: event.projectId,
      taskId: event.taskId,
      conversationId: event.conversationId,
      messageId,
      important: event.important === true || event.urgent,
    });
    const next: RuntimeEvent = { ...event, messageId: messageId ?? undefined, notificationId: stored.id };
    if (this.config.notifyLevel === "off") return;
    if (this.config.notifyLevel === "important" && event.important !== true && event.urgent !== true) return;
    this.#emit(next);
  }

  #lastAssistantMessageId(conversationId: string): number | null {
    const messages = this.store.listMessages(conversationId, 8);
    const found = [...messages].reverse().find((message) => message.role === "assistant");
    return found?.id ?? null;
  }

  getNotifications(limit = 80): import("@yuanfang/shared").NotificationRecord[] {
    return this.store.listNotifications(limit);
  }

  markNotificationsRead(): void {
    this.store.markAllNotificationsRead();
  }

  #emit(event: RuntimeEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A broken UI listener must not break the runtime.
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#usageTimer !== undefined) clearInterval(this.#usageTimer);
    for (const watched of this.#watched.values()) watched.stop();
    this.#watched.clear();
    for (const release of this.#taskClaims.values()) release();
    this.#taskClaims.clear();
    for (const timer of this.#indexTimers.values()) clearTimeout(timer);
    this.#indexTimers.clear();
    await this.mcp.close().catch(() => undefined);
    await this.harness.close(SYSTEM_CONTEXT).catch(() => undefined);
    this.store.close();
  }

  #checkModelAuth(): void {
    this.#status = { ...this.#status, warning: null };
    // The faux provider is test-only and has no credential to check.
    if (this.config.provider === "faux") return;
    if (this.models.getModel(this.config.provider, this.config.model) === undefined) return;
    void this.models
      .checkAuth(this.config.provider)
      .then((check) => {
        if (check !== undefined) return;
        const warning = `模型 ${this.config.provider}/${this.config.model} 没有可用凭据。请先在 Pi 登录，或在环境中配置对应 API Key。`;
        this.#status = { ...this.#status, warning };
        this.log("warn", warning);
        this.#emit({ type: "status", status: this.status() });
      })
      .catch((error: unknown) => {
        this.log("warn", `检查模型凭据失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }

  // ── provider credentials ────────────────────────────────────────────────

  async providers(): Promise<import("@yuanfang/shared").ProviderView[]> {
    const providers = this.models.getProviders();
    const views = await Promise.all(
      providers.map(async (provider) => {
        const [check, origin] = await Promise.all([
          this.models.checkAuth(provider.id).catch(() => undefined),
          this.credentials.origin(provider.id).catch(() => "none" as const),
        ]);
        return {
          id: provider.id,
          name: provider.name,
          apiKeyName: provider.auth.apiKey?.name ?? null,
          oauthName: provider.auth.oauth?.name ?? null,
          configured: check !== undefined,
          source: check?.source ?? null,
          origin:
            origin !== "none"
              ? origin
              : check?.source !== undefined
                ? ("env" as const)
                : ("none" as const),
          modelCount: this.models.getModels(provider.id).length,
        };
      }),
    );
    return views.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
  }

  async providerModels(providerId: string, refresh = false): Promise<import("@yuanfang/shared").ProviderModelsResult> {
    const errors: string[] = [];
    if (refresh) {
      const result = await this.models.refresh({ providers: [providerId], allowNetwork: true, force: true });
      for (const error of result.errors.values()) errors.push(error.message);
    }
    const check = await this.models.checkAuth(providerId).catch(() => undefined);
    const origin = await this.credentials.origin(providerId).catch(() => "none" as const);
    const provider = this.models.getProvider(providerId);
    if (provider === undefined) throw new Error(`provider ${providerId} not found`);
    return {
      provider: {
        id: provider.id,
        name: provider.name,
        apiKeyName: provider.auth.apiKey?.name ?? null,
        oauthName: provider.auth.oauth?.name ?? null,
        configured: check !== undefined,
        source: check?.source ?? null,
        origin:
          origin !== "none"
            ? origin
            : check?.source !== undefined
              ? ("env" as const)
              : ("none" as const),
        modelCount: this.models.getModels(providerId).length,
      },
      models: this.models.getModels(providerId).map((model) => ({
        provider: model.provider,
        modelId: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        supportsImages: model.input.includes("image"),
        inputCost: model.cost?.input ?? 0,
        outputCost: model.cost?.output ?? 0,
      })),
      errors,
    };
  }

  async saveProviderKey(
    providerId: string,
    key: string,
    env?: Record<string, string>,
  ): Promise<import("@yuanfang/shared").ProviderModelsResult> {
    const provider = this.models.getProvider(providerId);
    if (provider === undefined) throw new Error(`provider ${providerId} not found`);
    if (provider.auth.apiKey === undefined) throw new Error("该厂商不支持 API Key，请在 Pi 中完成 OAuth 登录");
    const trimmed = key.trim();
    if (trimmed.length === 0) throw new Error("API Key 不能为空");
    await this.credentials.modify(providerId, async () => ({
      type: "api_key",
      key: trimmed,
      ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
    }));
    return this.providerModels(providerId, true);
  }

  async removeProviderKey(providerId: string): Promise<import("@yuanfang/shared").ProviderModelsResult> {
    const origin = await this.credentials.origin(providerId);
    if (origin === "pi") throw new Error("这是 Pi 的凭据，请在 Pi 中退出，或直接保存一个新的 Key 覆盖");
    if (origin === "none") throw new Error("没有可删除的远方凭据");
    await this.credentials.delete(providerId);
    return this.providerModels(providerId, false);
  }

  // ── config ───────────────────────────────────────────────────────────────

  configView(): RuntimeConfigView {
    const persona = "";
    return {
      workspace: this.paths.workspace,
      agentName: this.config.agentName,
      projectsDir: this.paths.projectsDir,
      provider: this.config.provider,
      model: this.config.model,
      projectProvider: this.config.projectProvider,
      projectModel: this.config.projectModel,
      roleProvider: this.config.roleProvider,
      roleModel: this.config.roleModel,
      thinkingLevel: this.config.thinkingLevel,
      roleThinkingLevel: this.config.roleThinkingLevel,
      maxTurns: this.config.maxTurns,
      maxConcurrentTasks: this.config.maxConcurrentTasks,
      notifyLevel: this.config.notifyLevel,
      persona,
      personaPath: this.paths.personaFile,
      defaultProjectDir: this.paths.projectsDir,
      availableModels: this.#modelOptions(),
    };
  }

  async configViewWithPersona(): Promise<RuntimeConfigView> {
    return { ...this.configView(), persona: await readPersona(this.paths) };
  }

  getConfig(): AppConfig {
    return this.config;
  }

  async updateConfig(input: UpdateConfigInput): Promise<RuntimeConfigView> {
    if (input.persona !== undefined) await writePersona(this.paths, input.persona);
    const next: AppConfig = {
      ...this.config,
      ...(input.agentName === undefined || input.agentName.trim().length === 0
        ? {}
        : { agentName: input.agentName.trim() }),
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.projectProvider === undefined ? {} : { projectProvider: input.projectProvider }),
      ...(input.projectModel === undefined ? {} : { projectModel: input.projectModel }),
      ...(input.roleProvider === undefined ? {} : { roleProvider: input.roleProvider }),
      ...(input.roleModel === undefined ? {} : { roleModel: input.roleModel }),
      ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel as AppConfig["thinkingLevel"] }),
      ...(input.roleThinkingLevel === undefined
        ? {}
        : { roleThinkingLevel: input.roleThinkingLevel as AppConfig["thinkingLevel"] }),
      ...(input.maxTurns === undefined || !Number.isFinite(input.maxTurns)
        ? {}
        : { maxTurns: Math.max(1, Math.floor(input.maxTurns)) }),
      ...(input.maxConcurrentTasks === undefined || !Number.isFinite(input.maxConcurrentTasks)
        ? {}
        : { maxConcurrentTasks: Math.max(1, Math.min(32, Math.floor(input.maxConcurrentTasks))) }),
      ...(input.notifyLevel === undefined ? {} : { notifyLevel: input.notifyLevel }),
    };
    this.config = next;
    await saveConfig(this.paths, next);

    const system = await this.#systemConversation();
    await system
      .configure(
        {
          model: { provider: next.provider, modelId: next.model },
          thinkingLevel: next.thinkingLevel,
          maxTurns: next.maxTurns,
        },
        SYSTEM_CONTEXT,
      )
      .catch(() => undefined);
    for (const project of this.store.listProjectRecords()) {
      if (project.conversationId === null) continue;
      const conversation = await this.harness.conversation(cid(project.conversationId), SYSTEM_CONTEXT);
      await conversation
        ?.configure(
          {
            model: { provider: next.projectProvider, modelId: next.projectModel },
            thinkingLevel: next.thinkingLevel,
            maxTurns: next.maxTurns,
          },
          SYSTEM_CONTEXT,
        )
        .catch(() => undefined);
    }
    this.store.setKv("system_model", `${next.provider}/${next.model}`);
    this.#checkModelAuth();
    for (const project of this.store.listProjectRecords()) {
      this.store.setKv(`project_model:${project.id}`, `${next.projectProvider}/${next.projectModel}`);
    }
    this.#emit({ type: "status", status: this.status() });
    return this.configViewWithPersona();
  }

  #modelOptions(): ModelOption[] {
    const options = new Map<string, ModelOption>();
    for (const model of this.models.getModels()) {
      const key = `${model.provider}/${model.id}`;
      options.set(key, {
        provider: model.provider,
        modelId: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        supportsImages: model.input.includes("image"),
        inputCost: model.cost?.input ?? 0,
        outputCost: model.cost?.output ?? 0,
      });
    }
    for (const key of [
      `${this.config.provider}/${this.config.model}`,
      `${this.config.projectProvider}/${this.config.projectModel}`,
      `${this.config.roleProvider}/${this.config.roleModel}`,
    ]) {
      if (options.has(key)) continue;
      const [provider, ...rest] = key.split("/");
      options.set(key, {
        provider: provider ?? "",
        modelId: rest.join("/"),
        name: rest.join("/"),
        contextWindow: 0,
        supportsImages: false,
        inputCost: 0,
        outputCost: 0,
      });
    }
    return [...options.values()].sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId),
    );
  }

  // ── agents / scopes ──────────────────────────────────────────────────────

  scopeFor(conversationId: ConversationId | string): {
    kind: AgentKind;
    conversationId: string;
    project: ProjectRecord | undefined;
    task: TaskRecord | undefined;
  } {
    const id = String(conversationId);
    if (id === this.#systemId) {
      return { kind: "system", conversationId: id, project: undefined, task: undefined };
    }
    const task = this.store.getTaskByConversation(id);
    if (task !== undefined) {
      return {
        kind: "role",
        conversationId: id,
        project: this.store.getProjectRecord(task.projectId),
        task,
      };
    }
    const project = this.store.getProjectByConversation(id);
    if (project !== undefined) {
      return { kind: "project", conversationId: id, project, task: undefined };
    }
    return { kind: "system", conversationId: id, project: undefined, task: undefined };
  }

  #conversationKind(conversationId: string): { kind: AgentKind; projectId: string | null } {
    const scope = this.scopeFor(conversationId);
    return { kind: scope.kind, projectId: scope.project?.id ?? null };
  }

  async #ensureSystemConversation(): Promise<string> {
    const stored = this.store.getKv("system_conversation_id");
    let conversation: Conversation | undefined;
    if (stored !== undefined) {
      conversation = await this.harness.conversation(cid(stored), SYSTEM_CONTEXT);
    }
    if (conversation === undefined) {
      conversation = await this.harness.createConversation({ ownership: { kind: "ownerless" } }, SYSTEM_CONTEXT);
      this.store.setKv("system_conversation_id", String(conversation.id));
    }
    this.#systemId = String(conversation.id);
    await conversation.configure(
      {
        model: { provider: this.config.provider, modelId: this.config.model },
        thinkingLevel: this.config.thinkingLevel,
        cwd: this.paths.workspace,
        maxTurns: this.config.maxTurns,
        extensions: { remove: [this.#extensions.project, this.#extensions.role] },
        modelTools: { remove: [createWriteTool(), createEditTool()] },
      },
      SYSTEM_CONTEXT,
    );
    this.store.setKv("system_model", `${this.config.provider}/${this.config.model}`);
    await this.#attachConversation(conversation, "system", null);
    return this.#systemId;
  }

  async #systemConversation(): Promise<Conversation> {
    if (this.#systemId.length === 0) await this.#ensureSystemConversation();
    const conversation = await this.harness.conversation(cid(this.#systemId), SYSTEM_CONTEXT);
    if (conversation === undefined) throw new Error("system conversation is missing");
    return conversation;
  }

  async ensureProjectConversation(projectId: string): Promise<string> {
    const existing = this.#projectLocks.get(projectId);
    if (existing !== undefined) return existing;
    const promise = this.#ensureProjectConversation(projectId);
    this.#projectLocks.set(projectId, promise);
    try {
      return await promise;
    } finally {
      this.#projectLocks.delete(projectId);
    }
  }

  async #ensureProjectConversation(projectId: string): Promise<string> {
    const project = this.store.getProjectRecord(projectId);
    if (project === undefined) throw new Error(`project ${projectId} not found`);
    if (project.conversationId !== null) {
      const existing = await this.harness.conversation(cid(project.conversationId), SYSTEM_CONTEXT);
      if (existing !== undefined) {
        await this.#attachConversation(existing, "project", project.id);
        return project.conversationId;
      }
    }
    const conversation = await this.harness.createConversation({ ownership: { kind: "ownerless" } }, SYSTEM_CONTEXT);
    await conversation.configure(
      {
        model: { provider: this.config.projectProvider, modelId: this.config.projectModel },
        thinkingLevel: this.config.thinkingLevel,
        cwd: project.path,
        maxTurns: this.config.maxTurns,
        extensions: { remove: [this.#extensions.system, this.#extensions.role] },
      },
      SYSTEM_CONTEXT,
    );
    this.store.setProjectConversation(project.id, String(conversation.id));
    this.store.setKv(`project_model:${project.id}`, `${this.config.projectProvider}/${this.config.projectModel}`);
    await this.#attachConversation(conversation, "project", project.id);
    return String(conversation.id);
  }

  async #reconcileProjects(): Promise<void> {
    for (const project of this.store.listProjectRecords(true)) {
      try {
        await this.ensureProjectConversation(project.id);
      } catch (error) {
        this.log("warn", `项目 ${project.name} 的负责人对话不可用：${String(error)}`);
      }
    }
  }

  async #reconcileTasks(): Promise<void> {
    // A crash between the durable commit and the business-row update leaves a
    // task without durableTaskId even though its RoleRun exists. Match by the
    // durable task's own input before falling back to "todo".
    const inspection = await this.harness.inspect(SYSTEM_CONTEXT).catch(() => undefined);
    const roleRuns =
      inspection?.tasks.filter((entry) => entry.record.kind === "yuanfang.role-run") ?? [];
    for (const original of this.store.listActiveTaskRecords()) {
      let task = original;
      if (task.durableTaskId === null) {
        const dispatch = await this.harness.snapshot(DispatchRegistry, task.id, SYSTEM_CONTEXT).catch(() => undefined);
        if (dispatch !== undefined && dispatch.reporterId.length > 0) {
          this.store.updateTask(task.id, {
            conversationId: dispatch.roleConversationId.length > 0 ? dispatch.roleConversationId : null,
            durableTaskId: dispatch.reporterId,
          });
          task = this.store.getTaskRecord(task.id) ?? task;
        }
      }
      if (task.durableTaskId === null) {
        const match = roleRuns.find((entry) => {
          const input = entry.record.input as { dbTaskId?: unknown } | null;
          return input !== null && typeof input === "object" && input.dbTaskId === task.id;
        });
        if (match !== undefined) {
          const input = match.record.input as { roleConversationId?: unknown };
          this.store.updateTask(task.id, {
            conversationId:
              typeof input.roleConversationId === "string" ? input.roleConversationId : null,
            durableTaskId: String(match.record.id),
          });
          task = this.store.getTaskRecord(task.id) ?? task;
        }
      }
      if (task.durableTaskId === null) {
        if (task.status === "queued") {
          this.store.updateTask(task.id, { status: "todo" });
        } else if (task.status === "running" || task.status === "waiting") {
          this.store.updateTask(task.id, {
            status: "failed",
            error: "durable task record missing",
            finishedAt: Date.now(),
          });
        }
        continue;
      }
      try {
        const durable = await this.harness.getTask(task.durableTaskId as never, SYSTEM_CONTEXT);
        if (durable === undefined) {
          this.store.updateTask(task.id, {
            status: "failed",
            error: "durable task record missing",
            finishedAt: Date.now(),
          });
          continue;
        }
        if (durable.state.status === "terminal") {
          const outcome = durable.state.outcome;
          if (task.status === "queued" || task.status === "running" || task.status === "waiting") {
            this.store.updateTask(task.id, {
              status: outcome.status === "completed" ? "review" : "failed",
              finishedAt: Date.now(),
              error: outcome.status === "completed" ? null : outcome.status,
            });
          }
        }
      } catch {
        // A task from an older registry waits for its definition.
      }
    }
  }

  // ── watches / streaming ──────────────────────────────────────────────────

  async #attachConversation(
    conversation: Conversation,
    kind: AgentKind,
    projectId: string | null,
  ): Promise<void> {
    const id = String(conversation.id);
    if (this.#watched.has(id)) return;
    const watch = await conversation.watch(SYSTEM_CONTEXT);
    const state: WatchState = {
      kind,
      projectId,
      busy: false,
      partial: "",
      seen: new Set(watch.value.entries.map((entry) => String(entry.id))),
      tools: new Map(),
      lastAssistantText: "",
    };
    const watched: WatchedConversation = {
      state,
      stop: () => {
        void watch.stop();
      },
    };
    this.#watched.set(id, watched);
    watch.start(async (call) => {
      if (call.kind !== "value") return;
      this.#applyView(id, state, call.value);
    });
  }

  #applyView(conversationId: string, state: WatchState, view: ConversationView): void {
    const live = view.docs["pi.live"] as unknown as LiveState | undefined;
    const busy = live?.run !== undefined;
    if (busy !== state.busy) {
      state.busy = busy;
      this.#emit({
        type: "agent_busy",
        conversationId,
        kind: state.kind,
        projectId: state.projectId,
        busy,
      });
    }
    const partialMessage = live?.generation?.message as unknown as AssistantMessage | undefined;
    const partial = partialMessage === undefined ? "" : textOfAssistant(partialMessage);
    if (partial !== state.partial) {
      state.partial = partial;
      this.#emit({
        type: "assistant_delta",
        conversationId,
        kind: state.kind,
        projectId: state.projectId,
        text: partial,
      });
    }
    for (const slot of live?.tools ?? []) {
      const signature = `${slot.status}:${slot.output?.length ?? 0}:${slot.entry ?? ""}`;
      if (state.tools.get(slot.callId) === signature) continue;
      state.tools.set(slot.callId, signature);
      const toolStatus = slot.status === "done" ? (slot.entry === undefined ? "error" : "done") : "running";
      const task = this.store.getTaskByConversation(conversationId);
      if (task !== undefined) {
        this.store.appendTaskEvent({
          taskId: task.id,
          callId: slot.callId,
          name: slot.name,
          status: toolStatus,
          output: slot.output === undefined ? null : slot.output.slice(-4000),
          details: slot.details === undefined ? null : JSON.stringify(slot.details).slice(0, 8000),
        });
      }
      this.#emit({
        type: "tool",
        conversationId,
        callId: slot.callId,
        name: slot.name,
        status: toolStatus,
        ...(slot.output === undefined ? {} : { output: slot.output }),
      });
    }
    for (const entry of view.entries) {
      const entryId = String(entry.id);
      if (entry.kind !== "pi.assistant" || state.seen.has(entryId)) continue;
      state.seen.add(entryId);
      const message = entry.model?.[0] as AssistantMessage | undefined;
      const text = textOfAssistant(message);
      if (text.length === 0) continue;
      state.lastAssistantText = text;
      const appended = this.store.appendMessage({
        conversationId,
        agentKind: state.kind,
        projectId: state.projectId,
        role: "assistant",
        content: text,
        meta: { entryId },
        entryKey: `${conversationId}:${entryId}`,
      });
      if (appended !== undefined) this.#emit({ type: "assistant_message", message: appended });
    }
    if (!busy && state.partial.length > 0) {
      state.partial = "";
      this.#emit({
        type: "assistant_delta",
        conversationId,
        kind: state.kind,
        projectId: state.projectId,
        text: "",
      });
    }
  }

  // ── user turns ───────────────────────────────────────────────────────────

  async sendSystemMessage(text: string, options: SendSystemOptions = {}): Promise<ChatSendResult> {
    const conversationId = await this.#ensureSystemConversation();
    const conversation = await this.#systemConversation();
    const message = this.store.appendMessage({
      conversationId,
      agentKind: "system",
      projectId: null,
      role: options.role ?? "user",
      content: text,
      meta: options.meta ?? null,
    });
    if (message !== undefined) this.#emit({ type: "message_added", message });
    const submission = await conversation.submit(
      {
        type: "input",
        content: text,
        entry: { kind: options.entryKind ?? "yf.user", data: { source: "desktop" } },
      },
      SYSTEM_CONTEXT,
    );
    void this.#afterSystemTurn(conversationId, submission, text, options).catch((error: unknown) => {
      if (!this.#closed) this.log("error", `系统对话失败：${error instanceof Error ? error.message : String(error)}`);
    });
    return { conversationId, messageId: message?.id ?? 0 };
  }

  async #afterSystemTurn(
    conversationId: string,
    submission: Submission,
    userText: string,
    options: SendSystemOptions = {},
  ): Promise<void> {
    const settled = await submission.wait(SYSTEM_CONTEXT);
    this.store.setKv("system_last_active", String(Date.now()));
    await this.syncUsage(conversationId, null);
    if (settled.status === "done" && settled.answer !== undefined) {
      const answer =
        settled.answer === undefined ? "" : await this.#answerText(conversationId, settled.answer);
      this.store.addMemory({
        scope: "global",
        kind: "episode",
        title: clip(userText, 72),
        body: `${options.role === "event" ? (options.meta?.source === "project" ? "项目负责人" : "外部消息") : "用户"}：${clip(userText, 1200)}\n${this.config.agentName}：${clip(answer, 1800)}`,
        source: "system",
      });
      this.#notify({
        type: "notification",
        title: this.config.agentName,
        body: clip(answer, 180),
        projectId: null,
        taskId: null,
        conversationId,
        urgent: false,
      });
      await this.#resetSystemIfIdle(conversationId);
    } else {
      const text = `本轮没有完成：${settled.reason}${settled.detail === undefined ? "" : ` · ${detailText(settled.detail)}`}`;
      this.store.appendMessage({
        conversationId,
        agentKind: "system",
        projectId: null,
        role: "event",
        content: text,
      });
      this.#notify({
        type: "notification",
        title: `${this.config.agentName} · 运行中断`,
        important: true,
        body: text,
        projectId: null,
        taskId: null,
        conversationId,
        urgent: true,
      });
    }
    this.#emit({ type: "status", status: this.status() });
  }

  async #resetSystemIfIdle(conversationId?: string): Promise<void> {
    const id = conversationId ?? this.#systemId;
    if (id.length === 0) return;
    const live = await this.harness.snapshot(LiveDoc, cid(id), SYSTEM_CONTEXT).catch(() => undefined);
    if (live?.run !== undefined) return;
    const inbox = await this.harness.snapshot(InboxDoc, cid(id), SYSTEM_CONTEXT).catch(() => undefined);
    if ((inbox?.items.length ?? 0) > 0) return;
    const conversation = await this.harness.conversation(cid(id), SYSTEM_CONTEXT);
    if (conversation === undefined) return;
    await conversation.reset(systemHandoff(this.#promptDeps, id), SYSTEM_CONTEXT);
  }

  async sendProjectMessage(
    projectId: string,
    text: string,
    options: MessageOptions = {},
  ): Promise<ChatSendResult> {
    const projectRecord = this.store.getProjectRecord(projectId);
    if (projectRecord === undefined) throw new Error(`project ${projectId} not found`);
    if (projectRecord.status === "archived" && options.internal !== true) {
      throw new Error(`项目「${projectRecord.name}」已归档，请先在项目页恢复`);
    }
    if (projectRecord.status === "paused" && options.internal !== true) {
      throw new Error(`项目「${projectRecord.name}」已暂停，请先在项目页恢复`);
    }
    const conversationId = await this.ensureProjectConversation(projectId);
    this.store.touchProject(projectId);
    const conversation = await this.harness.conversation(cid(conversationId), SYSTEM_CONTEXT);
    if (conversation === undefined) throw new Error(`project conversation missing: ${projectId}`);
    const isReport = options.entryKind === "yf.task_report";
    const message = this.store.appendMessage({
      conversationId,
      agentKind: "project",
      projectId,
      role: options.displayRole ?? (isReport ? "event" : "user"),
      content: text,
      meta: options.meta ?? null,
    });
    if (message !== undefined) this.#emit({ type: "message_added", message });
    const startedAt = Date.now();
    const submission = await conversation.submit(
      {
        type: "input",
        content: text,
        whenBusy: "followUp",
        requestId: options.requestId,
        entry: {
          kind: options.entryKind ?? "yf.message",
          data: (options.meta ?? undefined) as JsonValue | undefined,
        },
      },
      SYSTEM_CONTEXT,
    );
    void this.#afterProjectTurn(
      projectId,
      conversationId,
      submission,
      isReport,
      startedAt,
    ).catch((error: unknown) => {
      if (!this.#closed) this.log("error", `项目对话失败：${error instanceof Error ? error.message : String(error)}`);
    });
    return { conversationId, messageId: message?.id ?? 0 };
  }

  async #afterProjectTurn(
    projectId: string,
    conversationId: string,
    submission: Submission,
    isReport: boolean,
    startedAt: number,
  ): Promise<void> {
    const settled = await submission.wait(SYSTEM_CONTEXT);
    this.store.addProjectTime(projectId, Date.now() - startedAt);
    await this.syncUsage(conversationId, projectId);
    if (settled.status !== "done") {
      const text = `项目负责人本轮未完成：${settled.reason}${settled.detail === undefined ? "" : ` · ${detailText(settled.detail)}`}`;
      this.store.appendMessage({
        conversationId,
        agentKind: "project",
        projectId,
        role: "event",
        content: text,
      });
      this.#notify({
        type: "notification",
        title: "项目负责人运行中断",
        body: text,
        projectId,
        taskId: null,
        conversationId,
        urgent: true,
      });
      return;
    }
    const answer =
      settled.answer === undefined ? "" : await this.#answerText(conversationId, settled.answer);
    if (!isReport && answer.length > 0) {
      this.store.addMemory({
        scope: projectId,
        kind: "episode",
        title: clip(answer, 72),
        body: clip(answer, 1800),
        source: "project-lead",
      });
      await this.#resetProjectIfIdle(projectId, conversationId);
    }
    this.#emit({ type: "status", status: this.status() });
  }

  async #resetProjectIfIdle(projectId: string, conversationId: string): Promise<void> {
    const live = await this.harness.snapshot(LiveDoc, cid(conversationId), SYSTEM_CONTEXT).catch(
      () => undefined,
    );
    if (live?.run !== undefined) return;
    const inbox = await this.harness.snapshot(InboxDoc, cid(conversationId), SYSTEM_CONTEXT).catch(
      () => undefined,
    );
    if ((inbox?.items.length ?? 0) > 0) return;
    const conversation = await this.harness.conversation(cid(conversationId), SYSTEM_CONTEXT);
    if (conversation === undefined) return;
    await conversation.reset(projectHandoff(this.#promptDeps, projectId, conversationId), SYSTEM_CONTEXT);
  }

  async messageProject(projectId: string, text: string, options?: MessageOptions): Promise<void> {
    await this.sendProjectMessage(projectId, text, options);
  }

  async messageSystem(text: string, options?: MessageOptions): Promise<void> {
    await this.sendSystemMessage(text, {
      role: "event",
      meta: options?.meta ?? { source: "project" },
      entryKind: options?.entryKind ?? "yf.project_message",
    });
    if (options?.entryKind !== undefined) {
      this.store.appendEvent("message_system", { text, kind: options.entryKind });
    }
  }

  async #answerText(conversationId: string, answerId: EntryId): Promise<string> {
    try {
      return await this.harness.commit(async (tx) => {
        const entry = await tx.entry(AssistantEntry, answerId);
        const message = entry?.model?.[0] as AssistantMessage | undefined;
        return textOfAssistant(message);
      }, SYSTEM_CONTEXT);
    } catch {
      const messages = this.store.listMessages(conversationId, 4);
      return [...messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
    }
  }

  // ── projects / tasks ─────────────────────────────────────────────────────

  async createProject(input: { name: string; brief: string; path?: string }): Promise<ProjectRecord> {
    const projectId = uid("prj");
    let directory = input.path === undefined ? join(this.paths.projectsDir, slugify(input.name)) : resolve(input.path);
    if (directory === "/" || directory === homedir()) {
      throw new Error("不能把 / 或用户主目录直接作为项目目录；请选一个子目录");
    }
    if (input.path === undefined) {
      let suffix = 2;
      // Pick a free directory; an existing non-empty directory gets a suffix.
      for (;;) {
        try {
          const entries = await readdir(directory);
          if (entries.length === 0) break;
          directory = join(this.paths.projectsDir, `${slugify(input.name)}-${suffix++}`);
        } catch {
          break;
        }
      }
    }
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(
        join(directory, "README.md"),
        `# ${input.name}\n\n${input.brief}\n\n---\n\n由「${this.config.agentName}」创建。\n`,
        { flag: "wx" },
      );
    } catch {
      // README already exists.
    }
    await execFileAsync("git", ["init"], { cwd: directory }).catch(() => undefined);
    const project = this.store.createProject({
      id: projectId,
      name: input.name,
      brief: input.brief,
      path: directory,
    });
    await this.ensureProjectConversation(project.id);
    const count = await this.indexProject(project.id);
    const digest = await this.indexer.digest(project.id, project.path, count);
    this.store.addMemory({
      scope: project.id,
      kind: "architecture",
      title: `项目架构：${project.name}`,
      body: digest,
      source: "system",
      pinned: true,
    });
    const summary = this.store.projectSummary(this.store.getProjectRecord(project.id)!);
    this.#emit({ type: "project_updated", project: summary });
    this.#notify({
      type: "notification",
      title: `新项目：${project.name}`,
      body: "项目负责人已接手，正在拆解任务。",
      projectId: project.id,
      taskId: null,
      conversationId: project.conversationId,
      urgent: false,
    });
    await this.messageProject(
      project.id,
      [
        `[系统] 项目已经创建。`,
        `名称：${input.name}`,
        `目标与边界：${input.brief}`,
        `工作目录：${directory}`,
        `文件索引：${count} 个文件`,
        "",
        "请先给出执行计划，拆成可验证的任务，然后用 dispatch_ready 启动所有就绪任务。需要用户决定的事先 request_approval。",
      ].join("\n"),
      {
        entryKind: "yf.kickoff",
        requestId: `kickoff:${project.id}`,
        displayRole: "event",
        meta: { source: "system", projectId: project.id },
      },
    );
    return this.store.getProjectRecord(project.id)!;
  }

  async indexProject(projectId: string): Promise<number> {
    const project = this.store.getProjectRecord(projectId);
    if (project === undefined) return 0;
    const files = await this.indexer.scan(project.path);
    this.store.replaceFileIndex(
      projectId,
      files.map((file) => ({
        path: file.path,
        size: file.size,
        mtime: file.mtime,
        language: file.language,
        summary: file.summary,
      })),
    );
    return files.length;
  }

  createTask(input: CreateTaskInput): TaskRecord {
    const project = this.store.getProjectRecord(input.projectId);
    if (project === undefined) throw new Error(`project ${input.projectId} not found`);
    if (project.status !== "active") {
      throw new Error(`项目「${project.name}」当前为 ${project.status}，不能新建任务`);
    }
    const task = this.store.createTask({
      id: uid("task"),
      projectId: input.projectId,
      title: input.title,
      brief: input.brief,
      role: input.role ?? "执行",
      dependsOn: input.dependsOn ?? [],
      files: input.files ?? [],
      model: `${this.config.roleProvider}/${this.config.roleModel}`,
    });
    this.#emit({ type: "task_updated", task: this.store.taskSummary(task) });
    return task;
  }

  async dispatchTask(taskId: string): Promise<{ reporterId: string; roleConversationId: string }> {
    const task = this.store.getTaskRecord(taskId);
    if (task === undefined) throw new Error(`task ${taskId} not found`);
    if (task.status !== "todo") throw new Error(`task ${task.title} is ${task.status}, not todo`);
    const tasks = this.store.listTaskRecords(task.projectId);
    const statuses = new Map(tasks.map((each) => [each.id, each.status]));
    const blocked = task.dependsOn.filter((dependency) => statuses.get(dependency) !== "done");
    if (blocked.length > 0) throw new Error(`dependencies not done: ${blocked.join(", ")}`);
    const project = this.store.getProjectRecord(task.projectId);
    if (project === undefined) throw new Error(`project ${task.projectId} not found`);
    if (project.status !== "active") {
      throw new Error(`项目「${project.name}」当前为 ${project.status}，不能派发任务`);
    }
    const activeCount = this.store
      .listActiveTaskRecords()
      .filter((each) => each.projectId === task.projectId && ["queued", "running", "waiting"].includes(each.status)).length;
    if (activeCount >= this.config.maxConcurrentTasks) {
      throw new Error(
        `项目「${project.name}」已有 ${activeCount} 个任务在运行（上限 ${this.config.maxConcurrentTasks}），等一个完成后再派发`,
      );
    }

    const projectConversationId = cid(await this.ensureProjectConversation(project.id));
    const [digest, memory, skillList] = await Promise.all([
      this.indexer.digest(project.id, project.path, this.store.fileCount(project.id)),
      Promise.resolve(renderMemoryDigestSyncFor(this.#promptDeps, project.id)),
      this.skills.list(project.id, project.path),
    ]);
    const roleDefinition = await this.roles.get(task.role);
    const instructions = roleInstructions({
      project,
      task,
      digest,
      memory,
      skills: skillList.map((skill) => `- ${skill.name}：${skill.description}`).join("\n") || "（暂无）",
      rolePrompt: roleDefinition.instructions,
    });

    if (!this.store.claimTaskForDispatch(task.id)) {
      throw new Error(`task ${task.title} was already dispatched`);
    }

    let result: { roleConversationId: string; reporterId: string };
    try {
      result = await this.harness.commit(async (tx) => {
        const anchor = await tx.createTask(this.#taskDefs.Anchor, null, {
          ownership: { kind: "conversation" },
          conversationId: projectConversationId,
          background: true,
        });
        const roleConversation = await tx.createConversation({
          ownership: { kind: "task", taskId: anchor },
        });
        await configure(tx, roleConversation.id, {
          model: { provider: this.config.roleProvider, modelId: this.config.roleModel },
          thinkingLevel: this.config.roleThinkingLevel,
          cwd: project.path,
          maxTurns: this.config.maxTurns,
          extensions: { remove: [this.#extensions.system, this.#extensions.project] },
          instructions,
        });
        const reporterInput: RoleRunInput = {
          dbTaskId: task.id,
          roleConversationId: String(roleConversation.id),
          projectConversationId: String(projectConversationId),
          projectId: project.id,
          title: task.title,
          role: task.role,
          brief: task.brief,
        };
        const reporter = await tx.createTask(this.#taskDefs.RoleRun, reporterInput, {
          ownership: { kind: "conversation" },
          conversationId: projectConversationId,
          background: true,
        });
        const dispatchDoc = await tx.doc(DispatchRegistry, task.id, task.id);
        dispatchDoc.reporterId = String(reporter);
        dispatchDoc.roleConversationId = String(roleConversation.id);
        return { roleConversationId: String(roleConversation.id), reporterId: String(reporter) };
      }, SYSTEM_CONTEXT);
    } catch (error) {
      this.store.updateTask(task.id, { status: "todo" });
      throw error;
    }

    this.store.updateTask(task.id, {
      conversationId: result.roleConversationId,
      durableTaskId: result.reporterId,
      model: `${this.config.roleProvider}/${this.config.roleModel}`,
    });
    const roleConversation = await this.harness.conversation(cid(result.roleConversationId), SYSTEM_CONTEXT);
    if (roleConversation !== undefined) {
      await this.#attachConversation(roleConversation, "role", project.id);
    }
    this.#emit({ type: "task_updated", task: this.store.taskSummary(this.store.getTaskRecord(task.id)!) });
    this.store.appendEvent("task_dispatched", { taskId: task.id, reporter: result.reporterId });
    return { reporterId: result.reporterId, roleConversationId: result.roleConversationId };
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = this.store.getTaskRecord(taskId);
    if (task === undefined) return;
    if (!["todo", "queued", "running", "waiting", "review"].includes(task.status)) return;
    this.releaseTaskClaims(task.id);
    if (task.durableTaskId !== null) {
      await this.harness.abortTask(task.durableTaskId as never, SYSTEM_CONTEXT).catch(() => undefined);
    }
    if (task.conversationId !== null) {
      const conversation = await this.harness.conversation(cid(task.conversationId), SYSTEM_CONTEXT);
      await conversation?.abort(SYSTEM_CONTEXT, { background: true }).catch(() => undefined);
    }
    this.store.updateTask(task.id, {
      status: "cancelled",
      finishedAt: Date.now(),
      error: "cancelled by user",
    });
    this.#emit({ type: "task_updated", task: this.store.taskSummary(this.store.getTaskRecord(task.id)!) });
  }

  acceptTask(taskId: string, note?: string): void {
    const task = this.store.getTaskRecord(taskId);
    if (task === undefined) throw new Error(`task ${taskId} not found`);
    if (task.status !== "review") throw new Error(`任务「${task.title}」当前为 ${task.status}，不是待验收状态`);
    this.store.updateTask(task.id, { status: "done", error: null });
    this.store.addMemory({
      scope: task.projectId,
      kind: "decision",
      title: `验收通过：${task.title}`,
      body: note?.trim().length ? note : (task.result ?? "项目负责人验收通过"),
      source: "project-lead",
    });
    const updated = this.store.getTaskRecord(task.id)!;
    this.#emit({ type: "task_updated", task: this.store.taskSummary(updated) });
    this.#notify({
      type: "notification",
      title: `验收通过：${task.title}`,
      body: note?.trim().length ? note : "任务已交付。",
      projectId: task.projectId,
      taskId: task.id,
      conversationId: task.conversationId,
      urgent: false,
    });
  }

  rejectTask(taskId: string, note: string): void {
    const task = this.store.getTaskRecord(taskId);
    if (task === undefined) throw new Error(`task ${taskId} not found`);
    if (task.status !== "review") throw new Error(`任务「${task.title}」当前为 ${task.status}，不是待验收状态`);
    const reason = note.trim().length > 0 ? note.trim() : "验收未通过";
    this.store.updateTask(task.id, {
      status: "todo",
      brief: `${task.brief}\n\n[验收退回] ${reason}`,
      error: `验收退回：${reason}`,
      result: null,
      finishedAt: null,
      durationMs: 0,
      conversationId: null,
      durableTaskId: null,
    });
    const updated = this.store.getTaskRecord(task.id)!;
    this.#emit({ type: "task_updated", task: this.store.taskSummary(updated) });
    this.#notify({
      type: "notification",
      title: `任务被退回：${task.title}`,
      body: reason,
      projectId: task.projectId,
      taskId: task.id,
      conversationId: task.conversationId,
      urgent: false,
    });
  }

  async retryTask(taskId: string): Promise<{ reporterId: string; roleConversationId: string }> {
    const task = this.store.getTaskRecord(taskId);
    if (task === undefined) throw new Error(`task ${taskId} not found`);
    if (task.status !== "failed" && task.status !== "cancelled") {
      throw new Error(`任务「${task.title}」当前为 ${task.status}，只有失败或取消的任务可以重试`);
    }
    this.store.updateTask(task.id, {
      status: "todo",
      error: null,
      result: null,
      finishedAt: null,
      durationMs: 0,
      conversationId: null,
      durableTaskId: null,
    });
    return this.dispatchTask(task.id);
  }

  async abortConversation(conversationId: string): Promise<void> {
    const conversation = await this.harness.conversation(cid(conversationId), SYSTEM_CONTEXT);
    await conversation?.abort(SYSTEM_CONTEXT);
  }

  reportTaskProgress(taskId: string, progress: string): void {
    this.store.setTaskProgress(taskId, progress);
    const task = this.store.getTaskRecord(taskId);
    if (task !== undefined) this.#emit({ type: "task_updated", task: this.store.taskSummary(task) });
  }

  async acquireTaskClaims(taskId: string, files: string[], signal?: AbortSignal): Promise<void> {
    if (files.length === 0 || this.#taskClaims.has(taskId)) return;
    const release = await this.locks.acquire(files, {
      owner: `task:${taskId}`,
      signal,
      reentrant: true,
    });
    this.#taskClaims.set(taskId, release);
  }

  releaseTaskClaims(taskId: string): void {
    const release = this.#taskClaims.get(taskId);
    if (release === undefined) return;
    this.#taskClaims.delete(taskId);
    release();
  }

  scheduleProjectIndex(projectId: string, delayMs = 1_500): void {
    const existing = this.#indexTimers.get(projectId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#indexTimers.delete(projectId);
      void this.indexProject(projectId).catch(() => undefined);
    }, delayMs);
    timer.unref?.();
    this.#indexTimers.set(projectId, timer);
  }

  // ── approvals ────────────────────────────────────────────────────────────

  createApproval(input: {
    kind: Approval["kind"];
    title: string;
    detail: string;
    payload?: Record<string, unknown>;
    projectId?: string | null;
    taskId?: string | null;
    conversationId?: string | null;
    requestedBy?: string;
  }): Approval {
    const approval = this.store.createApproval(input);
    this.#emit({ type: "approval_updated", approval });
    this.#emit({ type: "status", status: this.status() });
    return approval;
  }

  async resolveApproval(
    approvalId: string,
    status: "approved" | "denied",
    note: string | null,
  ): Promise<Approval | undefined> {
    const current = this.store.getApproval(approvalId);
    if (current === undefined) return undefined;
    if (current.status !== "pending") return current;
    const approval = this.store.resolveApproval(approvalId, status, note);
    if (approval === undefined) return this.store.getApproval(approvalId);
    let installFailure: string | null = null;
    if (approval.kind === "mcp" && status === "approved") {
      const payload = approval.payload as {
        serverName?: unknown;
        command?: unknown;
        url?: unknown;
        headers?: unknown;
        args?: unknown;
        env?: unknown;
        cwd?: unknown;
        projects?: unknown;
      };
      if (
        typeof payload.serverName === "string" &&
        (typeof payload.command === "string" || typeof payload.url === "string")
      ) {
        try {
          await this.mcp.install(payload.serverName, {
            ...(typeof payload.command === "string" ? { command: payload.command } : {}),
            ...(typeof payload.url === "string" ? { url: payload.url } : {}),
            ...(payload.headers !== null && typeof payload.headers === "object" && !Array.isArray(payload.headers)
              ? { headers: payload.headers as Record<string, string> }
              : {}),
            ...(Array.isArray(payload.args) ? { args: payload.args.filter((item): item is string => typeof item === "string") } : {}),
            ...(payload.env !== null && typeof payload.env === "object" && !Array.isArray(payload.env)
              ? { env: payload.env as Record<string, string> }
              : {}),
            ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
            ...(Array.isArray(payload.projects) ? { projects: payload.projects.filter((item): item is string => typeof item === "string") } : {}),
          });
        } catch (error) {
          installFailure = error instanceof Error ? error.message : String(error);
          this.log("error", `MCP ${payload.serverName} 安装失败：${installFailure}`);
          this.#notify({
            type: "notification",
            title: `MCP ${payload.serverName} 安装失败`,
            body: installFailure,
            important: true,
            projectId: approval.projectId,
            taskId: null,
            conversationId: approval.conversationId,
            urgent: true,
          });
        }
      }
    }
    this.#emit({ type: "approval_updated", approval });
    this.#emit({ type: "status", status: this.status() });
    // Task-scoped approvals are delivered by the durable RoleRun reporter,
    // which resumes the same role conversation and keeps the task alive.
    if (approval.taskId !== null) return approval;
    if (approval.conversationId !== null) {
      const conversation = await this.harness.conversation(cid(approval.conversationId), SYSTEM_CONTEXT);
      if (conversation !== undefined) {
        const scope = this.scopeFor(approval.conversationId);
        const text = [
          `[审批结果] ${approval.title}`,
          `结果：${status === "approved" ? "已批准" : "已拒绝"}`,
          note === null ? "" : `备注：${note}`,
          "",
          status === "approved"
            ? installFailure === null
              ? "现在可以继续执行。如果这是 shell/install 审批，对应的命令已被放行一次（24 小时内同一条命令可直接重试）。"
              : `审批通过，但接入失败：${installFailure}。请检查命令、依赖和网络，修正后重新发起审批。`
            : "不要执行该操作。请调整方案，或向用户说明替代路径。",
        ]
          .filter((line) => line.length > 0)
          .join("\n");
        this.store.appendMessage({
          conversationId: approval.conversationId,
          agentKind: scope.kind,
          projectId: approval.projectId,
          role: "event",
          content: text,
          meta: { approvalId: approval.id, status },
        });
        await conversation.submit(
          {
            type: "input",
            content: text,
            whenBusy: "followUp",
            entry: { kind: "yf.approval_result", data: { approvalId: approval.id, status } },
          },
          SYSTEM_CONTEXT,
        );
      }
    }
    return approval;
  }

  // ── reads for the UI ─────────────────────────────────────────────────────

  listProjects() {
    return this.store.listProjectRecords(true).map((project) => this.store.projectSummary(project));
  }

  getProjectRecord(projectId: string): ProjectRecord | undefined {
    return this.store.getProjectRecord(projectId);
  }

  setProjectStatus(projectId: string, status: "active" | "paused" | "archived"): void {
    this.store.setProjectStatus(projectId, status);
    const record = this.store.getProjectRecord(projectId);
    if (record !== undefined) this.#emit({ type: "project_updated", project: this.store.projectSummary(record) });
  }

  deleteProject(projectId: string): boolean {
    const project = this.store.getProjectRecord(projectId);
    if (project === undefined) return false;
    if (project.status !== "archived") throw new Error("只能删除已归档项目");
    const deleted = this.store.deleteProject(projectId);
    if (deleted) {
      this.store.appendEvent("project_deleted", { projectId });
      this.#emit({ type: "log", level: "info", message: `已删除项目 ${project.name}` });
    }
    return deleted;
  }

  projectRecordView(projectId: string): import("@yuanfang/shared").ProjectSummary | undefined {
    const record = this.store.getProjectRecord(projectId);
    return record === undefined ? undefined : this.store.projectSummary(record);
  }

  projectDetail(projectId: string): ProjectDetail | undefined {
    const record = this.store.getProjectRecord(projectId);
    if (record === undefined) return undefined;
    const summary = this.store.projectSummary(record);
    const tasks = this.store.listTaskRecords(projectId).map((task) => this.store.taskSummary(task));
    const memories = [...this.store.memoryDigest(projectId, 20), ...this.store.recentEpisodes(projectId, 12)]
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      .slice(0, 30);
    return {
      ...summary,
      readme: "",
      topLevel: [],
      tasks,
      agents: this.store.listAgents(projectId, this.config.agentName),
      memories,
    };
  }

  async projectDetailAsync(projectId: string): Promise<ProjectDetail | undefined> {
    const detail = this.projectDetail(projectId);
    if (detail === undefined) return undefined;
    const [readme, topLevel] = await Promise.all([
      this.indexer.readme(detail.path),
      this.indexer.topLevel(detail.path),
    ]);
    return { ...detail, readme, topLevel };
  }

  listTaskEvents(taskId: string): import("@yuanfang/shared").TaskEvent[] {
    return this.store.listTaskEvents(taskId);
  }

  listTasks(projectId: string): TaskSummary[] {
    return this.store.listTaskRecords(projectId).map((task) => this.store.taskSummary(task));
  }

  getConversationFeed(conversationId: string): {
    conversationId: string;
    kind: AgentKind;
    projectId: string | null;
    busy: boolean;
    messages: ChatMessage[];
    partial: string | null;
    tools: Array<{ callId: string; name: string; status: string; output?: string }>;
  } {
    const watched = this.#watched.get(conversationId);
    const kind = watched?.state.kind ?? this.#conversationKind(conversationId).kind;
    const projectId = watched?.state.projectId ?? this.#conversationKind(conversationId).projectId;
    return {
      conversationId,
      kind,
      projectId,
      busy: watched?.state.busy ?? false,
      messages: this.store.listMessages(conversationId),
      partial: watched?.state.partial.length ? watched.state.partial : null,
      tools: [],
    };
  }

  systemConversationFeed(): string {
    return this.#systemId;
  }

  getApprovals(status?: ApprovalStatus): Approval[] {
    return this.store.listApprovals(status);
  }

  getMemories(projectId?: string | null): import("@yuanfang/shared").MemoryEntry[] {
    return this.store.listMemories(projectId ?? "global", 100);
  }

  addMemory(input: {
    scope: string;
    kind: import("@yuanfang/shared").MemoryKind;
    title: string;
    body: string;
    tags?: string[];
    pinned?: boolean;
  }): import("@yuanfang/shared").MemoryEntry {
    return this.store.addMemory({ ...input, source: "desktop" });
  }

  async readSkill(name: string, projectId?: string | null): Promise<{ name: string; description: string; content: string; scope: string; path: string } | null> {
    const project = projectId === undefined || projectId === null ? undefined : this.store.getProjectRecord(projectId);
    const skill = await this.skills.read(name, project?.path ?? null);
    return skill === undefined
      ? null
      : { name: skill.name, description: skill.description, content: skill.content, scope: skill.scope, path: skill.path };
  }

  updateMemory(id: string, change: { title?: string; body?: string; tags?: string[]; pinned?: boolean }): import("@yuanfang/shared").MemoryEntry | undefined {
    return this.store.updateMemory(id, change);
  }

  deleteMemory(id: string): boolean {
    return this.store.deleteMemory(id);
  }

  async saveSkill(input: {
    name: string;
    description: string;
    body: string;
    scope?: "global" | "project";
    projectId?: string | null;
  }): Promise<import("@yuanfang/shared").SkillInfo> {
    const project = input.projectId === undefined || input.projectId === null
      ? undefined
      : this.store.getProjectRecord(input.projectId);
    return this.skills.write({
      name: input.name,
      description: input.description,
      body: input.body,
      scope: input.scope ?? "global",
      projectPath: project?.path ?? null,
    });
  }

  search(query: string, projectId?: string | null): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const memory of this.store.searchMemories(query, projectId ?? null, 10)) {
      hits.push({
        kind: "memory",
        title: memory.title,
        snippet: memory.body.slice(0, 300),
        score: memory.pinned ? 3 : 1,
        projectId: memory.scope === "global" ? null : memory.scope,
        ref: memory.id,
      });
    }
    const projects = projectId === undefined || projectId === null
      ? this.store.listProjectRecords()
      : this.store.listProjectRecords().filter((project) => project.id === projectId);
    for (const project of projects) {
      for (const file of this.store.searchFiles(project.id, query, 6)) {
        hits.push({
          kind: "file",
          title: file.path,
          snippet: file.summary,
          score: file.score,
          projectId: project.id,
          ref: `${project.id}:${file.path}`,
        });
      }
    }
    return hits.slice(0, 30);
  }

  getLocks(): FileLockInfo[] {
    return this.locks.snapshot();
  }

  async reloadPlugins(): Promise<void> {
    await this.plugins.loadAll();
  }

  async removePlugin(name: string): Promise<boolean> {
    return this.plugins.remove(name);
  }

  async removeSkill(name: string, scope: "global" | "project", projectId?: string | null): Promise<boolean> {
    const project = projectId === undefined || projectId === null ? undefined : this.store.getProjectRecord(projectId);
    return this.skills.delete(name, scope, project?.path ?? null);
  }

  // ── usage ────────────────────────────────────────────────────────────────

  async syncUsage(conversationId: string, projectId: string | null): Promise<void> {
    const state = (await this.harness.snapshot(
      UsageDoc,
      cid(conversationId),
      SYSTEM_CONTEXT,
    )) as UsageState | undefined;
    if (state === undefined) return;
    const totals = sumUsage(state);
    const { delta } = this.store.syncConversationUsage(conversationId, projectId, totals);
    const task = this.store.getTaskByConversation(conversationId);
    if (task !== undefined) {
      this.store.addTaskUsage(task.id, delta);
      const updated = this.store.getTaskRecord(task.id);
      if (updated !== undefined) this.#emit({ type: "task_updated", task: this.store.taskSummary(updated) });
    }
    if (projectId !== null) {
      const project = this.store.getProjectRecord(projectId);
      if (project !== undefined) this.#emit({ type: "project_updated", project: this.store.projectSummary(project) });
    }
  }

  async syncAllUsage(): Promise<void> {
    const seen = new Set<string>();
    if (this.#systemId.length > 0) {
      seen.add(this.#systemId);
      await this.syncUsage(this.#systemId, null).catch(() => undefined);
    }
    for (const project of this.store.listProjectRecords(true)) {
      if (project.conversationId === null) continue;
      seen.add(project.conversationId);
      await this.syncUsage(project.conversationId, project.id).catch(() => undefined);
      for (const task of this.store.listTaskRecords(project.id)) {
        if (task.conversationId === null || seen.has(task.conversationId)) continue;
        seen.add(task.conversationId);
        await this.syncUsage(task.conversationId, project.id).catch(() => undefined);
      }
    }
    this.#emit({ type: "status", status: this.status() });
  }

  statsForProject(projectId: string) {
    const record = this.store.getProjectRecord(projectId);
    return record === undefined ? emptyStats() : this.store.projectSummary(record).stats;
  }
}

function sumUsage(state: UsageState): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
} {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const usage of [...Object.values(state.models), ...Object.values(state.tools)]) {
    const value = usage as {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { total?: number };
    };
    total.input += value.input ?? 0;
    total.output += value.output ?? 0;
    total.cacheRead += value.cacheRead ?? 0;
    total.cacheWrite += value.cacheWrite ?? 0;
    total.cost += value.cost?.total ?? 0;
  }
  return total;
}

function detailText(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function cid(value: string): ConversationId {
  return Number(value) as ConversationId;
}

function textOfAssistant(message: AssistantMessage | undefined): string {
  if (message === undefined) return "";
  return message.content
    .flatMap((content) => (content.type === "text" ? [content.text] : []))
    .join("\n")
    .trim();
}

function clip(text: string, limit: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}…`;
}
