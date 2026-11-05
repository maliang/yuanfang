import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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
import type { MutableModels, Models } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type {
  AgentKind,
  Approval,
  ApprovalStatus,
  ChatMessage,
  ChatSendResult,
  CustomProviderInput,
  DraftProjectBriefInput,
  DraftProjectBriefResult,
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
import { loadConfig, readPersona, resolveUserPath, saveConfig, writePersona, type AppConfig, type Paths } from "./config.js";
import { openDatabase } from "./db.js";
import { LayeredFileCredentialStore } from "./credentials.js";
import { FileLockManager } from "./locks.js";
import { ProjectIndexer } from "./indexer.js";
import { SkillService } from "./skills.js";
import { PluginService } from "./plugins.js";
import { McpService } from "./mcp.js";
import {
  commitAll,
  commitTaskWorktree,
  conflictMarkerPaths,
  createTaskWorktree,
  currentHead,
  gitCommitInitial,
  mergeInsideWorktree,
  mergeIntoProject,
  removeTaskWorktree,
  unmergedPaths,
  type TaskWorktree,
} from "./worktree.js";
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
  /** Create/repair the daily-driver project. The desktop enables this; tests do not. */
  ensureDefaultProject?: boolean;
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
  #ensureDefaultProjectEnabled = false;
  #customProviders: CustomProviderInput[] = [];
  #budgetWarnedDay: string | null = null;
  #mergeQueue: Promise<void> = Promise.resolve();
  #logins = new Map<
    string,
    {
      providerId: string;
      controller: AbortController;
      prompts: Map<
        string,
        { resolve: (value: string) => void; reject: (error: unknown) => void }
      >;
    }
  >();

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
    this.#ensureDefaultProjectEnabled = options.ensureDefaultProject === true;
    const { config, paths } = await loadConfig(options.workspace);
    this.config = config;
    this.paths = paths;
    this.#status = {
      ...this.#status,
      workspace: paths.workspace,
      quickAskHotkey: config.quickAskHotkey,
    };

    this.store = new AppStore(openDatabase(paths.database), options.now ?? Date.now);
    this.indexer = new ProjectIndexer();
    this.skills = new SkillService(paths.skillsDir);
    this.credentials = new LayeredFileCredentialStore(paths.yuanfangAuthFile, paths.piAuthFile);
    this.models = options.models ?? builtinModels({ credentials: this.credentials });
    await this.#loadCustomProviders();
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

    this.plugins = new PluginService({
      directory: paths.pluginsDir,
      workspace: paths.workspace,
      projectsDir: paths.projectsDir,
      projectRootForConversation: (conversationId) => {
        const scope = this.scopeFor(conversationId);
        return scope.task?.worktreePath ?? scope.project?.path ?? null;
      },
      projectRoots: () => {
        const roots = this.store.listProjectRecords(true).map((project) => project.path);
        for (const project of this.store.listProjectRecords(true)) {
          for (const task of this.store.listTaskRecords(project.id)) {
            if (task.worktreePath !== null) roots.push(task.worktreePath);
          }
        }
        for (const watched of this.#watched.values()) {
          if (watched.state.projectId !== null) {
            const project = this.store.getProjectRecord(watched.state.projectId);
            if (project !== undefined) roots.push(project.path);
          }
        }
        return roots;
      },
      notify: (title, body) =>
        this.#notify({
          type: "notification",
          title,
          body,
          projectId: null,
          taskId: null,
          conversationId: null,
          urgent: false,
        }),
      registry: () => this.registry,
      log: (level, message) => this.log(level, message),
    });
    this.mcp = new McpService(
      paths.mcpFile,
      () => this.registry,
      (level, message) => this.log(level, message),
      (conversationId) => this.store.getProjectByConversation(conversationId)?.id ?? null,
      (url) => this.#emit({ type: "external_url", url }),
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
          // A provider must not leave a conversation "busy" forever. 5 minutes is
          // long enough for a large reasoning turn, short enough to recover.
          stream: { timeoutMs: 300_000, maxRetries: 2 },
          retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000, maxAgentDelayMs: 30_000 },
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
    await this.#recoverStaleTasks();

    this.locks.subscribe((locks) => this.#emit({ type: "locks", locks }));

    await this.#ensureSystemConversation();
    if (this.#ensureDefaultProjectEnabled) await this.#ensureDefaultProject();
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
    await this.plugins.close().catch(() => undefined);
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
        const warning = `模型 ${this.config.provider}/${this.config.model} 没有可用凭据。请在设置 → 厂商与凭据里填写 API Key 或完成 OAuth。`;
        this.#status = { ...this.#status, warning };
        this.log("warn", warning);
        this.#emit({ type: "status", status: this.status() });
      })
      .catch((error: unknown) => {
        this.log("warn", `检查模型凭据失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }

  // ── custom providers ────────────────────────────────────────────────────

  async #loadCustomProviders(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.paths.modelsFile, "utf8"));
      const providers = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { providers?: unknown }).providers
        : undefined;
      if (!Array.isArray(providers)) return;
      for (const raw of providers) {
        if (raw === null || typeof raw !== "object") continue;
        const input = raw as Partial<CustomProviderInput>;
        if (
          typeof input.id !== "string" ||
          typeof input.name !== "string" ||
          typeof input.baseUrl !== "string" ||
          !Array.isArray(input.models)
        ) {
          continue;
        }
        const models = input.models.filter((model): model is string => typeof model === "string" && model.trim().length > 0);
        if (models.length > 0) this.#registerCustomProvider({ id: input.id, name: input.name, baseUrl: input.baseUrl, models });
      }
    } catch {
      // No custom providers yet.
    }
  }

  #registerCustomProvider(input: CustomProviderInput): void {
    const id = input.id.trim();
    const baseUrl = input.baseUrl.trim().replace(/\/$/, "");
    const models = input.models.map((model) => model.trim()).filter(Boolean);
    const provider = createProvider({
      id,
      name: input.name.trim() || id,
      baseUrl,
      auth: {
        apiKey: {
          name: "API Key",
          resolve: async ({ credential }) => {
            const key = credential?.type === "api_key" ? credential.key : undefined;
            return key === undefined || key.length === 0 ? undefined : { auth: { apiKey: key } };
          },
        },
      },
      models: models.map((modelId) => ({
        id: modelId,
        name: modelId,
        api: "openai-completions" as const,
        provider: id,
        baseUrl,
        reasoning: false,
        input: ["text"] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      })),
      api: openAICompletionsApi(),
    });
    (this.models as MutableModels).setProvider(provider);
  }

  async saveCustomProvider(input: CustomProviderInput): Promise<import("@yuanfang/shared").ProviderModelsResult> {
    const id = input.id.trim().toLowerCase();
    const baseUrl = input.baseUrl.trim().replace(/\/$/, "");
    const models = input.models.map((model) => model.trim()).filter(Boolean);
    if (!/^[a-z][a-z0-9._-]{1,48}$/.test(id)) throw new Error("服务 ID 只能使用小写字母、数字、点、下划线或短横线");
    if (!/^https?:\/\//.test(baseUrl)) throw new Error("Base URL 必须以 http:// 或 https:// 开头");
    if (models.length === 0) throw new Error("至少填写一个模型 ID");
    if (this.models.getProvider(id) !== undefined && !this.#customProviders.some((item) => item.id === id)) {
      throw new Error(`provider ${id} 已存在，请换一个 ID`);
    }
    const next = { id, name: input.name.trim() || id, baseUrl, models };
    this.#registerCustomProvider(next);
    this.#customProviders = [...this.#customProviders.filter((item) => item.id !== id), next];
    await writeFile(
      this.paths.modelsFile,
      JSON.stringify({ version: 1, providers: this.#customProviders }, null, 2),
      { mode: 0o600 },
    );
    return this.providerModels(id, false);
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

  beginProviderLogin(providerId: string): { loginId: string } {
    const provider = this.models.getProvider(providerId);
    if (provider === undefined) throw new Error(`provider ${providerId} not found`);
    if (provider.auth.oauth === undefined) throw new Error("该厂商不支持 OAuth 登录");
    const loginId = uid("login");
    const controller = new AbortController();
    const login = { providerId, controller, prompts: new Map() };
    this.#logins.set(loginId, login);
    setImmediate(() => {
      void (async () => {
      try {
        await this.models.login(
          providerId,
          "oauth",
          {
            signal: controller.signal,
            notify: (event) => {
              this.#emit({ type: "login_event", loginId, providerId, event: event as import("@yuanfang/shared").LoginEventView });
            },
            prompt: (prompt) =>
              new Promise<string>((resolve, reject) => {
                if (controller.signal.aborted) {
                  reject(controller.signal.reason ?? new Error("cancelled"));
                  return;
                }
                const promptId = uid("auth");
                login.prompts.set(promptId, { resolve, reject });
                const abort = () => {
                  if (!login.prompts.delete(promptId)) return;
                  reject(controller.signal.reason ?? new Error("cancelled"));
                };
                controller.signal.addEventListener("abort", abort, { once: true });
                this.#emit({
                  type: "login_prompt",
                  loginId,
                  providerId,
                  prompt: {
                    id: promptId,
                    type: prompt.type,
                    message: prompt.message,
                    ...("placeholder" in prompt && prompt.placeholder !== undefined
                      ? { placeholder: prompt.placeholder }
                      : {}),
                    ...(prompt.type === "select"
                      ? { options: prompt.options.map((option) => ({ ...option })) }
                      : {}),
                  },
                });
              }),
          },
          { agentName: this.config.agentName },
        );
        this.#emit({ type: "login_done", loginId, providerId, ok: true });
      } catch (error) {
        this.#emit({
          type: "login_done",
          loginId,
          providerId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        for (const prompt of login.prompts.values()) prompt.reject(new Error("login ended"));
        this.#logins.delete(loginId);
      }
      })();
    });
    return { loginId };
  }

  respondLoginPrompt(loginId: string, promptId: string, value: string): void {
    const login = this.#logins.get(loginId);
    const prompt = login?.prompts.get(promptId);
    if (login === undefined || prompt === undefined) throw new Error("登录会话或输入项已过期");
    login.prompts.delete(promptId);
    prompt.resolve(value);
  }

  cancelProviderLogin(loginId: string): void {
    const login = this.#logins.get(loginId);
    if (login === undefined) return;
    login.controller.abort(new Error("登录已取消"));
    this.#logins.delete(loginId);
  }

  async listRoles(): Promise<import("@yuanfang/shared").RoleDefinitionView[]> {
    return this.roles.list();
  }

  async saveRole(input: {
    name: string;
    description: string;
    instructions: string;
    model: { provider: string; modelId: string } | null;
  }): Promise<import("@yuanfang/shared").RoleDefinitionView[]> {
    await this.roles.upsert(input.name, input.description, input.instructions, input.model);
    return this.roles.list();
  }

  async importPiCredentials(): Promise<number> {
    const imported = await this.credentials.importPiCredentials();
    if (imported > 0) {
      this.#checkModelAuth();
      this.#emit({ type: "status", status: this.status() });
    }
    return imported;
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
      worktreePerTask: this.config.worktreePerTask,
      dailyTokenBudget: this.config.dailyTokenBudget,
      updateFeedUrl: this.config.updateFeedUrl,
      quickAskHotkey: this.config.quickAskHotkey,
      theme: this.config.theme,
      accent: this.config.accent,
      uiScale: this.config.uiScale,
      defaultProjectId: "prj_default",
      defaultProjectName: this.config.defaultProjectName,
      defaultProjectPath: this.config.defaultProjectPath,
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
      ...(input.worktreePerTask === undefined ? {} : { worktreePerTask: input.worktreePerTask }),
      ...(input.dailyTokenBudget === undefined || !Number.isFinite(input.dailyTokenBudget)
        ? {}
        : { dailyTokenBudget: Math.max(0, Math.floor(input.dailyTokenBudget)) }),
      ...(input.updateFeedUrl === undefined ? {} : { updateFeedUrl: input.updateFeedUrl.trim() }),
      ...(input.quickAskHotkey === undefined || input.quickAskHotkey.trim().length === 0
        ? {}
        : { quickAskHotkey: input.quickAskHotkey.trim() }),
      ...(input.theme === undefined ? {} : { theme: input.theme }),
      ...(input.accent === undefined || !/^#[0-9a-fA-F]{6}$/.test(input.accent) ? {} : { accent: input.accent }),
      ...(input.uiScale === undefined || !Number.isFinite(input.uiScale)
        ? {}
        : { uiScale: Math.min(1.4, Math.max(0.8, Math.round(input.uiScale * 100) / 100)) }),
      ...(input.defaultProjectName === undefined || input.defaultProjectName.trim().length === 0
        ? {}
        : { defaultProjectName: input.defaultProjectName.trim() }),
      ...(input.defaultProjectPath === undefined || input.defaultProjectPath.trim().length === 0
        ? {}
        : { defaultProjectPath: resolveUserPath(input.defaultProjectPath) }),
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
    this.#checkBudget();
    for (const project of this.store.listProjectRecords()) {
      this.store.setKv(`project_model:${project.id}`, `${next.projectProvider}/${next.projectModel}`);
    }
    this.#status = { ...this.#status, quickAskHotkey: next.quickAskHotkey };
    if (this.#ensureDefaultProjectEnabled && (input.defaultProjectName !== undefined || input.defaultProjectPath !== undefined)) {
      await this.#ensureDefaultProject();
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

  async #ensureDefaultProject(): Promise<void> {
    const id = "prj_default";
    const name = this.config.defaultProjectName;
    const path = this.config.defaultProjectPath;
    if (path === "/" || path === homedir()) {
      this.log("warn", "默认项目路径不能是根目录或用户主目录；已跳过默认项目创建");
      return;
    }
    const existing = this.store.getProjectRecord(id);
    if (existing !== undefined && existing.name === name && existing.path === path) return;
    try {
      await mkdir(path, { recursive: true });
      if (existing === undefined) {
        try {
          await writeFile(
            join(path, "README.md"),
            `# ${name}

日常办公与零散文件的默认项目。\n\n---\n\n由「${this.config.agentName}」创建。\n`,
            { flag: "wx" },
          );
        } catch {
          // Existing README is fine.
        }
        await execFileAsync("git", ["init"], { cwd: path }).catch(() => undefined);
        this.store.createProject({
          id,
          name,
          brief: "日常办公与零散文件的默认项目。",
          path,
        });
      } else {
        this.store.updateProjectIdentity(id, name, path);
      }
      const record = this.store.getProjectRecord(id);
      if (record?.conversationId !== null && record?.conversationId !== undefined) {
        const conversation = await this.harness.conversation(cid(record.conversationId), SYSTEM_CONTEXT);
        await conversation?.configure({ cwd: path }, SYSTEM_CONTEXT).catch(() => undefined);
      }
      const count = await this.indexProject(id);
      const digest = await this.indexer.digest(id, path, count);
      this.store.addMemory({
        scope: id,
        kind: "architecture",
        title: `项目架构：${name}`,
        body: digest,
        source: "system",
        pinned: true,
      });
      const summary = this.store.projectSummary(this.store.getProjectRecord(id)!);
      this.#emit({ type: "project_updated", project: summary });
    } catch (error) {
      this.log("warn", `默认项目初始化失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #recoverStaleTasks(): Promise<void> {
    const now = Date.now();
    // Recover old pending checkpoints from before the stream timeout existed,
    // or a process killed mid-run. New requests are bounded by settings.stream.
    const generationLimit = 15 * 60_000;
    const toolLimit = 30 * 60_000;
    try {
      const inspection = await this.harness.inspect(SYSTEM_CONTEXT);
      for (const task of inspection.tasks) {
        if (task.record.startedAt === undefined) continue;
        const age = now - task.record.startedAt;
        if (age < 0) continue;
        const stale =
          (task.record.kind === "pi.generation" && age > generationLimit) ||
          (task.record.kind === "pi.tool" && age > toolLimit);
        if (!stale) continue;
        await this.harness.abortTask(task.record.id, SYSTEM_CONTEXT).catch((error: unknown) => {
          this.log("warn", `恢复卡住的任务失败：${String(error)}`);
        });
        this.log("warn", `已中止超时的 ${task.record.kind} 任务（${task.record.id}）`);
      }
    } catch (error) {
      this.log("warn", `检查卡住任务失败：${String(error)}`);
    }
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

  async draftProjectBrief(input: DraftProjectBriefInput): Promise<DraftProjectBriefResult> {
    const name = input.name.trim() || "未命名项目";
    const rawPath = input.path?.trim();
    let directory: string | undefined;
    let existing = false;
    let fileCount = 0;
    let readme = "";
    let topLevel: string[] = [];
    let fileSamples = "";
    if (rawPath !== undefined && rawPath.length > 0) {
      directory = resolveUserPath(rawPath);
      if (directory === "/" || directory === homedir()) {
        throw new Error("不能把 / 或用户主目录直接作为项目目录；请选一个子目录");
      }
      try {
        const info = await stat(directory);
        existing = info.isDirectory();
      } catch {
        existing = false;
      }
      if (existing) {
        try {
          const [files, top, readmeText] = await Promise.all([
            this.indexer.scan(directory),
            this.indexer.topLevel(directory),
            this.indexer.readme(directory),
          ]);
          fileCount = files.length;
          topLevel = top;
          readme = readmeText.slice(0, 5000);
          fileSamples = files
            .slice(0, 80)
            .map((file) => [file.path, file.language, file.summary].filter(Boolean).join(" · "))
            .join("\n");
        } catch {
          // Best-effort preview; creation will surface real filesystem errors.
        }
      }
    }
    const fallback = this.#fallbackProjectBrief(name, existing, fileCount, readme, topLevel);
    const model = this.models.getModel(this.config.projectProvider, this.config.projectModel);
    if (model === undefined) {
      return {
        brief: fallback,
        fileCount,
        existing,
        ai: false,
        warning: `模型 ${this.config.projectProvider}/${this.config.projectModel} 不可用，已用本地目录摘要填充简介。`,
      };
    }
    try {
      const contextText = [
        `项目名：${name}`,
        `目录：${directory ?? "（尚未创建，将自动生成）"}`,
        `状态：${existing ? `已存在的目录，索引到 ${fileCount} 个文件` : "新目录"}`,
        topLevel.length > 0 ? `顶层结构：${topLevel.join("、")}` : "",
        readme.length > 0 ? `README 摘要：\n${readme}` : "",
        fileSamples.length > 0 ? `文件样本：\n${fileSamples}` : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n");
      const message = await this.models.complete(
        model,
        {
          systemPrompt:
            "你是元芳，一个务实的软件项目参谋长。请根据用户提供的项目名、目录、README 和文件样本，用中文写一段项目简介。简介只描述：这个项目是什么、给谁用、当前技术栈/结构、目前处于什么阶段。不要写目标承诺、验收标准、实施计划或客套话；不要使用 Markdown；直接输出一段 80-180 字的正文。",
          messages: [
            {
              role: "user",
              content: `${contextText}\n\n请直接输出项目简介：`,
              timestamp: Date.now(),
            },
          ],
        },
        { maxTokens: 320, temperature: 0.3, timeoutMs: 30_000 },
      );
      const brief = textOfAssistant(message)
        .replace(/^["'“”]+|["'“”]+$/g, "")
        .replace(/[\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 600);
      if (brief.length === 0) throw new Error("模型返回了空简介");
      return { brief, fileCount, existing, ai: true, warning: null };
    } catch (error) {
      return {
        brief: fallback,
        fileCount,
        existing,
        ai: false,
        warning: `AI 简介生成失败：${error instanceof Error ? error.message : String(error)}。已用本地目录摘要填充，可以手动修改。`,
      };
    }
  }

  #fallbackProjectBrief(
    name: string,
    existing: boolean,
    fileCount: number,
    readme: string,
    topLevel: string[],
  ): string {
    if (!existing) {
      return `${name} 是一个新建项目，当前还没有代码。项目负责人会在启动后结合目录和对话逐步建立对项目的理解，并在执行过程中持续更新。`;
    }
    const readmeLine = readme
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line.length > 0 && !line.startsWith("```") && !line.startsWith("!"));
    const shape = topLevel.slice(0, 8).join("、");
    return [
      `已存在的项目目录，当前索引到 ${fileCount} 个文件${shape.length > 0 ? `，顶层包含 ${shape}` : ""}。`,
      readmeLine === undefined ? "" : readmeLine.slice(0, 240),
      "项目负责人会在启动后结合代码索引进一步理解项目。",
    ]
      .filter((part) => part.length > 0)
      .join(" ");
  }

  async createProject(input: { name: string; brief: string; path?: string }): Promise<ProjectRecord> {
    const projectId = uid("prj");
    let directory = input.path === undefined ? join(this.paths.projectsDir, slugify(input.name)) : resolveUserPath(input.path);
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
    if (input.path === undefined) await gitCommitInitial(directory);
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
        `项目简介：${input.brief}`,
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
      stage: input.stage,
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
    if (this.#budgetExceeded()) {
      throw new Error(`今日 token 预算 ${this.config.dailyTokenBudget} 已用完，请在设置里调整预算`);
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
    const roleModel = roleDefinition.model ?? { provider: this.config.roleProvider, modelId: this.config.roleModel };
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

    let worktree: TaskWorktree | undefined;
    if (this.config.worktreePerTask) {
      worktree = await createTaskWorktree({
        projectPath: project.path,
        workspace: this.paths.workspace,
        projectId: project.id,
        taskId: task.id,
      });
      if (worktree === undefined) {
        this.reportTaskProgress(task.id, "git 工作区不干净或不是 git 仓库，已回退到主工作区");
      }
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
          model: roleModel,
          thinkingLevel: this.config.roleThinkingLevel,
          cwd: worktree?.path ?? project.path,
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
          ...(worktree === undefined ? {} : { worktreePath: worktree.path }),
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
      if (worktree !== undefined) await removeTaskWorktree(project.path, worktree).catch(() => undefined);
      this.store.updateTask(task.id, { status: "todo" });
      throw error;
    }

    this.store.updateTask(task.id, {
      conversationId: result.roleConversationId,
      durableTaskId: result.reporterId,
      model: `${roleModel.provider}/${roleModel.modelId}`,
      worktreePath: worktree?.path ?? null,
      worktreeBranch: worktree?.branch ?? null,
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
    const cancelProject = this.store.getProjectRecord(task.projectId);
    if (cancelProject !== undefined && task.worktreePath !== null && task.worktreeBranch !== null) {
      await removeTaskWorktree(cancelProject.path, { path: task.worktreePath, branch: task.worktreeBranch });
    }
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
      worktreePath: null,
      worktreeBranch: null,
    });
    this.#emit({ type: "task_updated", task: this.store.taskSummary(this.store.getTaskRecord(task.id)!) });
  }

  #withMergeLock<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#mergeQueue.then(run, run);
    this.#mergeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  async #mergeTaskWorktree(project: ProjectRecord, task: TaskRecord): Promise<void> {
    if (task.worktreePath === null || task.worktreeBranch === null) return;
    const worktree: TaskWorktree = { path: task.worktreePath, branch: task.worktreeBranch };
    // A previous crash may have left an unfinished merge in the worktree.
    await this.#abortWorktreeMerge(worktree);
    await commitTaskWorktree(worktree, `yuanfang: ${task.title}`);
    const direct = await mergeIntoProject(project.path, worktree.branch, `yuanfang: accept ${task.title}`);
    if (direct.ok) {
      await removeTaskWorktree(project.path, worktree);
      this.store.updateTask(task.id, { worktreePath: null, worktreeBranch: null });
      this.scheduleProjectIndex(task.projectId);
      return;
    }
    if (direct.conflicts.length === 0) {
      throw new Error("合并失败：主工作区可能有未提交修改，或 git 拒绝合并");
    }

    const base = await currentHead(project.path);
    const merged = await mergeInsideWorktree(worktree, base);
    if (!merged.ok) {
      if (merged.conflicts.length === 0) {
        await this.#abortWorktreeMerge(worktree);
        throw new Error("自动合并失败：无法进入冲突解决状态");
      }
      try {
        await this.#resolveWorktreeConflicts(project, task, worktree, merged.conflicts);
      } catch (error) {
        await this.#abortWorktreeMerge(worktree);
        throw error;
      }
    }
    const final = await mergeIntoProject(project.path, worktree.branch, `yuanfang: accept ${task.title}`);
    if (!final.ok) {
      throw new Error(
        `冲突已解决，但主工作树在合并期间又发生变化。请重试验收。冲突文件：${final.conflicts.join(", ")}`,
      );
    }
    await removeTaskWorktree(project.path, worktree);
    this.store.updateTask(task.id, { worktreePath: null, worktreeBranch: null });
    this.scheduleProjectIndex(task.projectId);
  }

  async #abortWorktreeMerge(worktree: TaskWorktree): Promise<void> {
    try {
      await execFileAsync("git", ["-C", worktree.path, "merge", "--abort"]);
    } catch {
      // No merge in progress.
    }
  }

  async #resolveWorktreeConflicts(
    project: ProjectRecord,
    task: TaskRecord,
    worktree: TaskWorktree,
    conflicts: string[],
  ): Promise<void> {
    const role = await this.roles.get("代码审查");
    const model = role.model ?? { provider: this.config.roleProvider, modelId: this.config.roleModel };
    const conversation = await this.harness.createConversation(
      { ownership: { kind: "ownerless" } },
      SYSTEM_CONTEXT,
    );
    await conversation.configure(
      {
        model,
        thinkingLevel: this.config.roleThinkingLevel,
        cwd: worktree.path,
        maxTurns: Math.max(20, this.config.maxTurns),
        instructions: [
          "你负责解决 git merge 冲突。",
          "冲突来自其他已验收任务推进了主分支，而当前任务分支需要合并主分支。",
          "保留双方意图，不要为了让冲突消失而删除别人的功能。",
          "解决冲突标记后，运行相关测试或至少做语法/类型检查。",
          "最后用 git add -A 并 commit 完成 merge；不要留下未解决冲突。",
        ].join("\n"),
        extensions: { remove: [this.#extensions.system, this.#extensions.project] },
      },
      SYSTEM_CONTEXT,
    );
    const prompt = [
      `请解决项目「${project.name}」的合并冲突。`,
      `项目主工作树：${project.path}`,
      `任务工作树：${worktree.path}`,
      `冲突文件：${conflicts.join(", ")}`,
      "",
      "目标：把主分支合并进当前任务分支，解决所有冲突，然后提交 merge commit。",
      "完成后报告：冲突文件、解决策略、验证结果。",
    ].join("\n");
    const submission = await conversation.submit(
      {
        type: "input",
        content: prompt,
        requestId: `merge-resolve:${task.id}:${worktree.branch}`,
        entry: { kind: "yf.merge_conflict", data: { taskId: task.id, conflicts } },
      },
      SYSTEM_CONTEXT,
    );
    const settled = await submission.wait(SYSTEM_CONTEXT);
    if (settled.status !== "done") {
      throw new Error(`冲突解决 Agent 未完成：${settled.reason}`);
    }
    await commitAll(worktree, `yuanfang: resolve conflicts for ${task.title}`);
    const remaining = await unmergedPaths(worktree);
    if (remaining.length > 0) {
      throw new Error(`冲突仍未解决：${remaining.join(", ")}`);
    }
    const marked = await conflictMarkerPaths(worktree, conflicts);
    if (marked.length > 0) {
      throw new Error(`冲突文件仍包含冲突标记：${marked.join(", ")}`);
    }
  }

  async acceptTask(taskId: string, note?: string): Promise<void> {
    const task = this.store.getTaskRecord(taskId);
    if (task === undefined) throw new Error(`task ${taskId} not found`);
    if (task.status !== "review") throw new Error(`任务「${task.title}」当前为 ${task.status}，不是待验收状态`);
    const project = this.store.getProjectRecord(task.projectId);
    if (project !== undefined && project.workflow.length > 0) {
      const finalStage = project.workflow[project.workflow.length - 1];
      if (task.stage !== finalStage) {
        throw new Error(`任务在阶段「${task.stage}」，必须先推进到「${finalStage}」才能验收`);
      }
    }
    if (project !== undefined && task.worktreePath !== null && task.worktreeBranch !== null) {
      await this.#withMergeLock(async () => {
        const current = this.store.getTaskRecord(task.id);
        if (current === undefined || current.status !== "review") {
          throw new Error(`任务「${task.title}」已不在待验收状态`);
        }
        await this.#mergeTaskWorktree(project, task);
      });
    }
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

  async advanceTask(taskId: string): Promise<void> {
    const task = this.store.getTaskRecord(taskId);
    if (task === undefined) throw new Error(`task ${taskId} not found`);
    const project = this.store.getProjectRecord(task.projectId);
    if (project === undefined) throw new Error(`project ${task.projectId} not found`);
    if (!["todo", "review", "failed", "cancelled"].includes(task.status)) {
      throw new Error(`任务「${task.title}」正在 ${task.status}，不能推进阶段`);
    }
    const index = project.workflow.indexOf(task.stage);
    const next = index >= 0 ? project.workflow[index + 1] : undefined;
    if (next === undefined) throw new Error(`任务「${task.title}」已经是最后一个阶段（${task.stage}）`);
    if (task.worktreePath !== null && task.worktreeBranch !== null) {
      await removeTaskWorktree(project.path, { path: task.worktreePath, branch: task.worktreeBranch });
    }
    this.store.updateTask(task.id, {
      stage: next,
      status: "todo",
      error: null,
      result: null,
      finishedAt: null,
      durationMs: 0,
      conversationId: null,
      durableTaskId: null,
      worktreePath: null,
      worktreeBranch: null,
    });
    const updated = this.store.getTaskRecord(task.id)!;
    this.#emit({ type: "task_updated", task: this.store.taskSummary(updated) });
  }

  setWorkflow(projectId: string, stages: string[]): void {
    const project = this.store.getProjectRecord(projectId);
    if (project === undefined) throw new Error(`project ${projectId} not found`);
    const clean = stages.map((stage) => stage.trim()).filter((stage) => stage.length > 0);
    if (clean.length === 0) throw new Error("工作流至少需要一个阶段");
    this.store.setProjectWorkflow(projectId, clean);
    this.#emit({ type: "project_updated", project: this.store.projectSummary(this.store.getProjectRecord(projectId)!) });
  }

  async rejectTask(taskId: string, note: string): Promise<void> {
    const task = this.store.getTaskRecord(taskId);
    if (task === undefined) throw new Error(`task ${taskId} not found`);
    if (task.status !== "review") throw new Error(`任务「${task.title}」当前为 ${task.status}，不是待验收状态`);
    const project = this.store.getProjectRecord(task.projectId);
    if (project !== undefined && task.worktreePath !== null && task.worktreeBranch !== null) {
      await removeTaskWorktree(project.path, { path: task.worktreePath, branch: task.worktreeBranch });
    }
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
    const retryProject = this.store.getProjectRecord(task.projectId);
    if (retryProject !== undefined && task.worktreePath !== null && task.worktreeBranch !== null) {
      await removeTaskWorktree(retryProject.path, { path: task.worktreePath, branch: task.worktreeBranch });
    }
    this.store.updateTask(task.id, {
      worktreePath: null,
      worktreeBranch: null,
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
    if (approval.kind === "plugin" && status === "approved") {
      const name = typeof approval.payload.name === "string" ? approval.payload.name : "";
      if (name.length > 0) {
        try {
          await this.plugins.reload(name);
        } catch (error) {
          installFailure = error instanceof Error ? error.message : String(error);
          this.log("error", `插件 ${name} 加载失败：${installFailure}`);
          this.#notify({
            type: "notification",
            title: `插件 ${name} 加载失败`,
            body: installFailure,
            projectId: approval.projectId,
            taskId: null,
            conversationId: approval.conversationId,
            urgent: true,
            important: true,
          });
        }
      }
    }
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
        oauth?: unknown;
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
            ...(payload.oauth !== null && typeof payload.oauth === "object" && !Array.isArray(payload.oauth)
              ? { oauth: payload.oauth as { clientId?: string; clientSecret?: string; scope?: string; authorizationServerMetadataUrl?: string } }
              : {}),
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
    return this.store
      .listProjectRecords(true)
      .map((project) => this.store.projectSummary(project))
      .sort((a, b) => Number(b.id === "prj_default") - Number(a.id === "prj_default"));
  }

  getProjectRecord(projectId: string): ProjectRecord | undefined {
    return this.store.getProjectRecord(projectId);
  }

  setProjectStatus(projectId: string, status: "active" | "paused" | "archived"): void {
    this.store.setProjectStatus(projectId, status);
    const record = this.store.getProjectRecord(projectId);
    if (record !== undefined) this.#emit({ type: "project_updated", project: this.store.projectSummary(record) });
  }

  async deleteProject(projectId: string): Promise<boolean> {
    const project = this.store.getProjectRecord(projectId);
    if (project === undefined) return false;
    if (project.status !== "archived") throw new Error("只能删除已归档项目");
    for (const task of this.store.listTaskRecords(projectId)) {
      if (task.worktreePath !== null && task.worktreeBranch !== null) {
        await removeTaskWorktree(project.path, { path: task.worktreePath, branch: task.worktreeBranch });
      }
    }
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

  async savePlugin(name: string, code: string, permissions?: string[]): Promise<import("@yuanfang/shared").PluginInfo> {
    return this.plugins.save(name, code, permissions);
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
    this.#checkBudget();
    if (projectId !== null) {
      const project = this.store.getProjectRecord(projectId);
      if (project !== undefined) this.#emit({ type: "project_updated", project: this.store.projectSummary(project) });
    }
  }

  #budgetExceeded(): boolean {
    if (this.config.dailyTokenBudget <= 0) return false;
    return this.store.getDailyUsage().tokens >= this.config.dailyTokenBudget;
  }

  #checkBudget(): void {
    if (this.config.dailyTokenBudget <= 0) {
      if (this.#status.warning?.includes("token 预算") === true) {
        this.#status = { ...this.#status, warning: null };
        this.#emit({ type: "status", status: this.status() });
      }
      return;
    }
    const usage = this.store.getDailyUsage();
    if (usage.tokens < this.config.dailyTokenBudget) return;
    this.#status = {
      ...this.#status,
      warning: `今日 token 预算 ${this.config.dailyTokenBudget} 已用完（已用 ${usage.tokens}）。新任务会被拒绝，可在设置里调整。`,
    };
    this.#emit({ type: "status", status: this.status() });
    if (this.#budgetWarnedDay !== usage.day) {
      this.#budgetWarnedDay = usage.day;
      this.#notify({
        type: "notification",
        title: "今日 token 预算已用完",
        body: `已用 ${usage.tokens} / ${this.config.dailyTokenBudget}，新任务会被拒绝。`,
        projectId: null,
        taskId: null,
        conversationId: null,
        urgent: false,
        important: true,
      });
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
