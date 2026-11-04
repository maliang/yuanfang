import {
  defineExtension,
  defineTool,
  hook,
  ToolTask,
  wrapTool,
  type Extension,
  type ToolRegistration,
  type Wrap,
} from "@earendil-works/pi-durable";
import { bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { JsonValue } from "@earendil-works/chord";
import { CodingTools, createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { hashCommand } from "./store.js";
import type { AgentScope, RuntimeHost } from "./host.js";
import type { PromptDeps } from "./prompts.js";
import { projectSections, roleSections, sharedSections, systemSections } from "./prompts.js";

type TextResult = {
  output: Array<{ type: "text"; text: string }>;
  details?: JsonValue;
};

function out(text: string, details?: JsonValue): TextResult {
  return details === undefined ? { output: [{ type: "text", text }] } : { output: [{ type: "text", text }], details };
}

function conversationIdOf(api: { conversationId: number }): string {
  return String(api.conversationId);
}

function projectFor(host: RuntimeHost, scope: AgentScope, projectId: string | undefined) {
  if (projectId === undefined || projectId.length === 0) return scope.project;
  return host.store.getProjectRecord(projectId);
}

function formatProject(host: RuntimeHost, projectId: string): string {
  const project = host.store.getProjectRecord(projectId);
  if (project === undefined) return `项目 ${projectId} 不存在`;
  const summary = host.store.projectSummary(project);
  const counts = summary.taskCounts;
  return [
    `项目：${project.name}（${project.id}） · ${project.status}`,
    `简介：${project.brief}`,
    `路径：${project.path}`,
    `进行中：${summary.activeTaskCount} · todo ${counts.todo} / running ${counts.running} / done ${counts.done} / failed ${counts.failed}`,
    `用时：${(summary.totalMs / 1000).toFixed(1)}s · tokens ${summary.stats.totalTokens} · 缓存命中 ${(summary.stats.cacheHitRate * 100).toFixed(1)}%`,
  ].join("\n");
}

function formatTask(task: import("./store.js").TaskRecord): string {
  const deps = task.dependsOn.length > 0 ? ` · 依赖 ${task.dependsOn.join(",")}` : "";
  const progress = task.progress === null ? "" : `\n  进度：${task.progress}`;
  const error = task.error === null ? "" : `\n  错误：${task.error}`;
  const result = task.result === null ? "" : `\n  结果：${task.result.slice(0, 500)}`;
  return `- [${task.id}] ${task.title} · ${task.status} · ${task.role}${deps}${progress}${error}${result}`;
}

function buildSharedTools(host: RuntimeHost): ToolRegistration[] {
  const remember = defineTool({
    name: "remember",
    description:
      "Write a durable memory. Use for user preferences, project decisions, architecture facts and hard-won lessons. Scope defaults to the current project, or global for the system agent.",
    parameters: obj({
      title: str({ description: "Short memorable title" }),
      body: str({ description: "What to remember, including why it matters" }),
      kind: opt(oneOf(["note", "decision", "architecture", "preference", "episode"])),
      scope: opt(str({ description: "global, or a project id; defaults to the current project" })),
      tags: opt(str({ description: "Comma-separated tags" })),
      pinned: opt(bool({ description: "Pinned memories always appear in the prompt" })),
    }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      const target = args.scope ?? scope.project?.id ?? "global";
      const memory = host.store.addMemory({
        scope: target,
        kind: args.kind ?? "note",
        title: args.title,
        body: args.body,
        tags: (args.tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
        source: `${scope.kind}:${api.conversationId}`,
        pinned: args.pinned ?? false,
      });
      return out(`已记住：${memory.title}（${memory.id}，scope=${memory.scope}）`);
    },
  });

  const updateMemory = defineTool({
    name: "update_memory",
    description: "Edit an existing memory by id: title, body, tags or pinned. Use this instead of writing a near-duplicate note.",
    parameters: obj({
      id: str(),
      title: opt(str()),
      body: opt(str()),
      tags: opt(str({ description: "Comma-separated tags" })),
      pinned: opt(bool()),
    }),
    execute: async (args) => {
      const updated = host.updateMemory(args.id, {
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.body === undefined ? {} : { body: args.body }),
        ...(args.tags === undefined ? {} : { tags: splitList(args.tags) }),
        ...(args.pinned === undefined ? {} : { pinned: args.pinned }),
      });
      return out(updated === undefined ? `记忆 ${args.id} 不存在。` : `记忆已更新：${updated.title}`);
    },
  });

  const forgetMemory = defineTool({
    name: "forget_memory",
    description: "Delete a memory by id. Only do this when the memory is wrong, obsolete, or the user asked to forget it.",
    parameters: obj({ id: str() }),
    execute: async (args) => {
      const removed = host.deleteMemory(args.id);
      return out(removed ? `已删除记忆 ${args.id}。` : `记忆 ${args.id} 不存在。`);
    },
  });

  const recall = defineTool({
    name: "recall",
    description: "Search durable memories for the current project and globally.",
    parameters: obj({
      query: str(),
      limit: opt(num({ description: "Default 8" })),
    }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      const memories = host.store.searchMemories(args.query, scope.project?.id ?? null, args.limit ?? 8);
      if (memories.length === 0) return out("没有找到相关记忆。");
      return out(
        memories
          .map((memory) => `- [${memory.kind}${memory.pinned ? " · 置顶" : ""}] ${memory.title}：${memory.body}`)
          .join("\n"),
      );
    },
  });

  const requestApproval = defineTool({
    name: "request_approval",
    description:
      "Ask the user to approve a privileged action (installing software, adding an MCP server, network or account access, dangerous commands). The request is durable; the user's answer arrives as a new message.",
    parameters: obj({
      kind: oneOf(["shell", "install", "mcp", "network", "other"]),
      title: str(),
      detail: str({ description: "What will happen, why it is needed, and how to undo it" }),
      command: opt(str({ description: "Exact shell command, when kind is shell/install" })),
    }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      const payload: Record<string, unknown> = {
        ...(scope.project === undefined ? {} : { projectId: scope.project.id }),
      };
      if (args.command !== undefined) {
        payload.command = args.command;
        payload.commandHash = hashCommand(args.command);
      }
      const approval = host.createApproval({
        kind: args.kind,
        title: args.title,
        detail: args.detail,
        payload,
        projectId: scope.project?.id ?? null,
        taskId: scope.task?.id ?? null,
        conversationId: scope.conversationId,
        requestedBy: scope.kind,
      });
      host.notify({
        type: "notification",
        title: "需要你批准",
        body: args.title,
        projectId: scope.project?.id ?? null,
        taskId: scope.task?.id ?? null,
        conversationId: scope.conversationId,
        urgent: true,
        important: true,
        approvalId: approval.id,
      });
      return out(
        `审批已提交（id=${approval.id}）。用户批准或拒绝后，你会收到一条新的对话消息。等待期间可以继续做不依赖该操作的部分；不要重复提交同一个审批。`,
        { approvalId: approval.id },
      );
    },
  });

  const notifyUser = defineTool({
    name: "notify_user",
    description: "Send a short desktop notification to the user. Use for milestones and blockers, not for routine chatter.",
    parameters: obj({
      title: str(),
      body: str(),
      urgent: opt(bool()),
    }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      host.notify({
        type: "notification",
        title: args.title,
        body: args.body,
        projectId: scope.project?.id ?? null,
        taskId: scope.task?.id ?? null,
        conversationId: scope.conversationId,
        urgent: args.urgent ?? false,
      });
      return out("通知已发送。");
    },
  });

  const repoFind = defineTool({
    name: "repo_find",
    description: "Search the project file index by path or summary. Use it to locate files before reading them.",
    parameters: obj({
      query: str({ description: "Path fragment, filename, symbol or topic" }),
      projectId: opt(str()),
    }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      const project = projectFor(host, scope, args.projectId);
      if (project === undefined) return out("当前对话不属于任何项目。请提供 projectId。");
      if (host.store.fileCount(project.id) === 0) await host.indexProject(project.id);
      const hits = host.store.searchFiles(project.id, args.query, 20);
      if (hits.length === 0) return out("索引中没有匹配的文件。可以先用 index_project 重建索引。");
      return out(
        hits.map((hit) => `- ${hit.path}${hit.language ? ` [${hit.language}]` : ""}${hit.summary ? ` — ${hit.summary}` : ""}`).join("\n"),
        { projectId: project.id, hits },
      );
    },
  });

  const listSkills = defineTool({
    name: "list_skills",
    description: "List available skills (global and project). Skills are Markdown instructions stored under ~/.yuanfang/skills.",
    parameters: obj({}),
    execute: async (_args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      const skills = await host.skills.list(scope.project?.id ?? null, scope.project?.path ?? null);
      if (skills.length === 0) return out("暂无技能。");
      return out(skills.map((skill) => `- ${skill.name}（${skill.scope}）：${skill.description}`).join("\n"));
    },
  });

  const readSkill = defineTool({
    name: "read_skill",
    description: "Read a skill's full instructions.",
    parameters: obj({ name: str() }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      const skill = await host.skills.read(args.name, scope.project?.path ?? null);
      if (skill === undefined) return out(`没有找到技能 ${args.name}。`);
      return out(`# ${skill.name}\n${skill.description}\n\n${skill.content}`);
    },
  });

  const webSearch = defineTool({
    name: "web_search",
    description: "Search the public web (DuckDuckGo HTML) and return titles, URLs and snippets. Use it to find tools, docs and prior art.",
    parameters: obj({
      query: str(),
      limit: opt(num({ description: "Default 6, max 10" })),
    }),
    execute: async (args) => {
      const limit = Math.min(10, Math.max(1, args.limit ?? 6));
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
      try {
        const response = await fetch(url, {
          headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Yuanfang/0.1" },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) return out(`搜索失败：HTTP ${response.status}`);
        const html = await response.text();
        const results: Array<{ title: string; url: string; snippet: string }> = [];
        const linkPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        const snippetPattern = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        const snippets: string[] = [];
        for (let match = snippetPattern.exec(html); match !== null; match = snippetPattern.exec(html)) {
          snippets.push(htmlToText(match[1] ?? ""));
        }
        let index = 0;
        for (let match = linkPattern.exec(html); match !== null && results.length < limit; match = linkPattern.exec(html)) {
          let href = decodeHtml(match[1] ?? "");
          if (href.startsWith("//duckduckgo.com/l/?uddg=")) {
            try {
              href = decodeURIComponent(new URL(`https:${href}`).searchParams.get("uddg") ?? href);
            } catch {
              // keep the original href
            }
          }
          results.push({ title: htmlToText(match[2] ?? ""), url: href, snippet: snippets[index] ?? "" });
          index += 1;
        }
        if (results.length === 0) return out("没有找到搜索结果（可能被搜索服务限流）。可以改用 web_fetch 直接抓取文档页面。");
        return out(
          results.map((result, i) => `${i + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`).join("\n"),
          { results },
        );
      } catch (error) {
        return out(`搜索失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  const webFetch = defineTool({
    name: "web_fetch",
    description: "Fetch a URL and return readable text (HTML tags stripped). Use for docs, changelogs, package pages and search results.",
    parameters: obj({
      url: str(),
      maxChars: opt(num({ description: "Default 12000, max 40000" })),
    }),
    execute: async (args) => {
      let target: URL;
      try {
        target = new URL(args.url);
        if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("只支持 http/https");
      } catch (error) {
        return out(`URL 无效：${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const response = await fetch(target, {
          headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Yuanfang/0.1" },
          signal: AbortSignal.timeout(25_000),
          redirect: "follow",
        });
        if (!response.ok) return out(`抓取失败：HTTP ${response.status} ${response.statusText}`);
        const contentType = response.headers.get("content-type") ?? "";
        const raw = await response.text();
        const text = contentType.includes("html") ? htmlToText(raw) : raw;
        const limit = Math.min(40_000, Math.max(500, args.maxChars ?? 12_000));
        return out(text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text);
      } catch (error) {
        return out(`抓取失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  const roleList = defineTool({
    name: "role_list",
    description: "List project role definitions (name, description, instructions) that can be assigned to tasks.",
    parameters: obj({}),
    execute: async () => {
      const roles = await host.roles.list();
      return out(roles.map((role) => `- ${role.name}：${role.description}`).join("\n") || "暂无角色定义。");
    },
  });

  const searchEverything = defineTool({
    name: "search_everything",
    description: "Search memories and the current project's file index in one call.",
    parameters: obj({
      query: str(),
      projectId: opt(str()),
    }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      const project = projectFor(host, scope, args.projectId);
      const lines: string[] = [];
      const memories = host.store.searchMemories(args.query, project?.id ?? null, 6);
      if (memories.length > 0) {
        lines.push("## 记忆");
        lines.push(...memories.map((memory) => `- ${memory.title}：${memory.body.slice(0, 300)}`));
      }
      if (project !== undefined) {
        if (host.store.fileCount(project.id) === 0) await host.indexProject(project.id);
        const files = host.store.searchFiles(project.id, args.query, 10);
        if (files.length > 0) {
          lines.push("## 文件");
          lines.push(...files.map((file) => `- ${file.path}${file.summary ? ` — ${file.summary}` : ""}`));
        }
      }
      return out(lines.length === 0 ? "没有找到相关内容。" : lines.join("\n"));
    },
  });

  return [
    remember,
    updateMemory,
    forgetMemory,
    recall,
    requestApproval,
    notifyUser,
    repoFind,
    listSkills,
    readSkill,
    searchEverything,
    roleList,
    webSearch,
    webFetch,
  ];
}

function buildSystemTools(host: RuntimeHost): ToolRegistration[] {
  const createProject = defineTool({
    name: "create_project",
    description:
      "Create a project: a directory, a project lead agent, and an empty task board. Use when the user's request needs sustained work.",
    parameters: obj({
      name: str({ description: "Short project name" }),
      brief: str({ description: "Goal, scope, constraints, acceptance criteria" }),
      path: opt(str({ description: "Absolute path; defaults to the workspace projects directory" })),
    }),
    execute: async (args) => {
      const project = await host.createProject({ name: args.name, brief: args.brief, path: args.path });
      return out(`${formatProject(host, project.id)}\n\n项目负责人已启动，正在拆解任务。`, { projectId: project.id });
    },
  });

  const listProjects = defineTool({
    name: "list_projects",
    description: "List all projects with live card statistics.",
    parameters: obj({}),
    execute: async () => {
      const projects = host.store.listProjectRecords(true);
      if (projects.length === 0) return out("还没有项目。");
      return out(
        projects
          .map((project) => {
            const summary = host.store.projectSummary(project);
            return `${formatProject(host, project.id)}\n  最后活动：${new Date(summary.lastActiveAt).toLocaleString("zh-CN")}`;
          })
          .join("\n\n"),
      );
    },
  });

  const projectStatus = defineTool({
    name: "project_status",
    description: "Get a project's summary, task board, and recent results.",
    parameters: obj({ projectId: str() }),
    execute: async (args) => {
      const project = host.store.getProjectRecord(args.projectId);
      if (project === undefined) return out(`项目 ${args.projectId} 不存在。`);
      const tasks = host.store.listTaskRecords(project.id);
      const memories = host.store.memoryDigest(project.id, 6);
      return out(
        [
          formatProject(host, project.id),
          "",
          "## 任务",
          tasks.length === 0 ? "（空）" : tasks.map(formatTask).join("\n"),
          "",
          "## 记忆",
          memories.length === 0 ? "（空）" : memories.map((memory) => `- ${memory.title}：${memory.body.slice(0, 240)}`).join("\n"),
        ].join("\n"),
      );
    },
  });

  const messageProject = defineTool({
    name: "message_project",
    description:
      "Send a message to a project lead. It is queued if the lead is busy and answered asynchronously; the lead reports back with notify_user / message_system.",
    parameters: obj({
      projectId: str(),
      message: str(),
    }),
    execute: async (args) => {
      const project = host.store.getProjectRecord(args.projectId);
      if (project === undefined) return out(`项目 ${args.projectId} 不存在。`);
      await host.messageProject(project.id, args.message, { entryKind: "yf.system_message" });
      return out(`已发送给项目负责人：${project.name}。它会在处理完后回复。`);
    },
  });

  const setProjectStatus = defineTool({
    name: "set_project_status",
    description: "Pause, resume or archive a project.",
    parameters: obj({
      projectId: str(),
      status: oneOf(["active", "paused", "archived"]),
    }),
    execute: async (args) => {
      const project = host.store.getProjectRecord(args.projectId);
      if (project === undefined) return out(`项目 ${args.projectId} 不存在。`);
      host.store.setProjectStatus(project.id, args.status);
      host.notify({ type: "project_updated", project: host.store.projectSummary(host.store.getProjectRecord(project.id)!) });
      return out(`项目 ${project.name} 已设为 ${args.status}。`);
    },
  });

  const createTask = defineTool({
    name: "create_task",
    description: "Create a task on a project board without dispatching it. Prefer letting the project lead do this.",
    parameters: obj({
      projectId: str(),
      title: str(),
      brief: str(),
      role: opt(str({ description: "Role name, e.g. 架构师 / 前端 / 后端 / 测试 / 文档" })),
      files: opt(str({ description: "Comma-separated files this task may modify" })),
      dependsOn: opt(str({ description: "Comma-separated task ids" })),
    }),
    execute: async (args) => {
      const task = host.createTask({
        projectId: args.projectId,
        title: args.title,
        brief: args.brief,
        role: args.role,
        files: splitList(args.files),
        dependsOn: splitList(args.dependsOn),
      });
      return out(`任务已创建：${formatTask(task)}`, { taskId: task.id });
    },
  });

  const taskList = defineTool({
    name: "task_list",
    description: "List tasks of a project.",
    parameters: obj({ projectId: str() }),
    execute: async (args) => {
      const tasks = host.store.listTaskRecords(args.projectId);
      if (tasks.length === 0) return out("任务板为空。");
      return out(tasks.map(formatTask).join("\n"));
    },
  });

  const skillList = defineTool({
    name: "skill_list",
    description: "List skills. Alias of list_skills with the same data.",
    parameters: obj({}),
    execute: async () => {
      const skills = await host.skills.list();
      return out(skills.map((skill) => `- ${skill.name}：${skill.description}`).join("\n") || "暂无技能。");
    },
  });

  const skillWrite = defineTool({
    name: "skill_write",
    description:
      "Create or update a skill (SKILL.md). Skills are durable instructions the system and projects can reuse. Write concrete procedures, not generalities.",
    parameters: obj({
      name: str(),
      description: str(),
      body: str({ description: "Markdown instructions. Include when to use it, steps, pitfalls, verification." }),
      scope: opt(oneOf(["global", "project"])),
    }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      const skill = await host.skills.write({
        name: args.name,
        description: args.description,
        body: args.body,
        scope: args.scope ?? "global",
        projectPath: args.scope === "project" ? (scope.project?.path ?? null) : null,
      });
      return out(`技能已写入：${skill.path}`);
    },
  });

  const pluginList = defineTool({
    name: "plugin_list",
    description: "List installed Yuanfang plugins in ~/.yuanfang/plugins.",
    parameters: obj({}),
    execute: async () => {
      const plugins = await host.plugins.list();
      if (plugins.length === 0) return out("暂无插件。");
      return out(
        plugins
          .map((plugin) => `- ${plugin.name}${plugin.loaded ? "" : "（未加载）"}：${plugin.description}${plugin.error === null ? "" : ` · 错误：${plugin.error}`}`)
          .join("\n"),
      );
    },
  });

  const pluginWrite = defineTool({
    name: "plugin_write",
    description:
      "Create or replace a plugin (.mjs) and hot-load it into the running registry. This is trusted in-process code: keep it small, no secrets, and verify it loads.",
    parameters: obj({
      name: str(),
      code: str({ description: "ES module exporting name, description and activate(ctx)." }),
    }),
    execute: async (args) => {
      const result = await host.plugins.write(args.name, args.code);
      return out(
        `插件 ${result.name} ${result.loaded ? "已加载" : "加载失败"}${result.error === null ? "" : `：${result.error}`}\n路径：${result.path}`,
        { plugin: result.name, loaded: result.loaded },
      );
    },
  });

  const pluginReload = defineTool({
    name: "plugin_reload",
    description: "Reload a plugin from disk after editing it.",
    parameters: obj({ name: str() }),
    execute: async (args) => {
      const result = await host.plugins.reload(args.name);
      return out(`插件 ${result.name} ${result.loaded ? "已重新加载" : "加载失败"}${result.error === null ? "" : `：${result.error}`}`);
    },
  });

  const writePersona = defineTool({
    name: "write_persona",
    description: "Update the system agent's persona. Takes effect on the next model request.",
    parameters: obj({ persona: str({ description: "Full Markdown persona" }) }),
    execute: async (args) => {
      const { writePersona } = await import("./config.js");
      await writePersona(host.paths, args.persona);
      return out("人格已更新。");
    },
  });

  const indexProject = defineTool({
    name: "index_project",
    description: "Scan a project directory and rebuild its file index.",
    parameters: obj({ projectId: str() }),
    execute: async (args) => {
      const count = await host.indexProject(args.projectId);
      return out(`索引完成：${count} 个文件。`);
    },
  });

  const retryTask = defineTool({
    name: "retry_task",
    description: "Retry a failed or cancelled task by putting it back to todo and dispatching a fresh role run.",
    parameters: obj({ taskId: str() }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      const task = host.store.getTaskRecord(args.taskId);
      if (task === undefined) return out(`任务 ${args.taskId} 不存在。`);
      if (scope.project !== undefined && task.projectId !== scope.project.id) return out("不能重试其他项目的任务。");
      try {
        await host.retryTask(task.id);
        return out(`任务已重新派发：${task.title}`);
      } catch (error) {
        return out(`重试失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  const roleUpsert = defineTool({
    name: "role_upsert",
    description: "Create or update a reusable role definition. The role is injected into role agents assigned to a task.",
    parameters: obj({
      name: str(),
      description: str(),
      instructions: str({ description: "Role-specific behavior, constraints and quality bar" }),
    }),
    execute: async (args) => {
      const role = await host.roles.upsert(args.name, args.description, args.instructions);
      return out(`角色已保存：${role.name} — ${role.description}`);
    },
  });

  const mcpAdd = defineTool({
    name: "mcp_add",
    description:
      "Ask the user to approve connecting an MCP server over stdio. After approval the server's tools are installed into the live registry (mcp_<server>_<tool>).",
    parameters: obj({
      name: str({ description: "Short server name, used in tool names" }),
      command: opt(str({ description: "Executable for a stdio server, e.g. npx or node" })),
      args: opt(str({ description: "JSON array of arguments" })),
      env: opt(str({ description: "JSON object of environment variables" })),
      cwd: opt(str()),
      url: opt(str({ description: "Streamable HTTP MCP endpoint; omit command" })),
      headers: opt(str({ description: "JSON object of HTTP headers" })),
      projects: opt(str({ description: "Comma-separated project ids allowed to use this server; empty = all" })),
    }),
    execute: async (args, api) => {
      let parsedArgs: string[] = [];
      let parsedEnv: Record<string, string> = {};
      let parsedHeaders: Record<string, string> = {};
      try {
        if (args.args !== undefined) {
          const value: unknown = JSON.parse(args.args);
          if (!Array.isArray(value)) throw new Error("args 必须是 JSON 数组");
          parsedArgs = value.map((item) => String(item));
        }
        if (args.env !== undefined) {
          const value: unknown = JSON.parse(args.env);
          if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("env 必须是 JSON 对象");
          parsedEnv = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
        }
        if (args.headers !== undefined) {
          const value: unknown = JSON.parse(args.headers);
          if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("headers 必须是 JSON 对象");
          parsedHeaders = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
        }
      } catch (error) {
        return out(`参数解析失败：${error instanceof Error ? error.message : String(error)}`);
      }
      if ((args.command ?? "").trim().length === 0 && (args.url ?? "").trim().length === 0) {
        return out("需要提供 command（stdio）或 url（HTTP）之一。");
      }
      const scope = host.scopeFor(conversationIdOf(api));
      const approval = host.createApproval({
        kind: "mcp",
        title: `接入 MCP：${args.name}`,
        detail: [
          args.url === undefined ? `命令：${args.command ?? ""} ${parsedArgs.join(" ")}` : `HTTP：${args.url}`,
          args.env === undefined ? "" : `环境变量：${Object.keys(parsedEnv).join(", ") || "（无）"}`,
          args.projects === undefined || args.projects.trim().length === 0
            ? "可用项目：全部"
            : `可用项目：${args.projects}`,
          "批准后服务器会以子进程方式启动，它的工具会出现在所有 Agent 的工具列表里。",
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
        payload: {
          serverName: args.name,
          ...(args.command === undefined ? {} : { command: args.command }),
          ...(args.url === undefined ? {} : { url: args.url }),
          args: parsedArgs,
          env: parsedEnv,
          headers: parsedHeaders,
          projects: splitList(args.projects),
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        },
        projectId: scope.project?.id ?? null,
        conversationId: scope.conversationId,
        requestedBy: scope.kind,
      });
      host.notify({
        type: "notification",
        title: "需要你批准 MCP 接入",
        body: args.name,
        projectId: scope.project?.id ?? null,
        taskId: null,
        conversationId: scope.conversationId,
        urgent: true,
        important: true,
        approvalId: approval.id,
      });
      return out(`已提交 MCP 接入审批（id=${approval.id}）。批准后工具会自动安装，你会收到消息。`);
    },
  });

  const mcpList = defineTool({
    name: "mcp_list",
    description: "List configured MCP servers, their connection state and installed tools.",
    parameters: obj({}),
    execute: async () => {
      const servers = await host.mcp.list();
      if (servers.length === 0) return out("暂无 MCP 服务器。用 mcp_add 申请接入。");
      return out(
        servers
          .map(
            (server) =>
              `- ${server.name} · ${server.connected ? "已连接" : "未连接"} · ${server.url ?? `${server.command} ${server.args.join(" ")}`}${server.projects.length > 0 ? ` · 项目 ${server.projects.join(",")}` : ""}\n  工具：${server.tools.map((tool) => tool.name).join(", ") || "（无）"}${server.error === null ? "" : `\n  错误：${server.error}`}`,
          )
          .join("\n"),
      );
    },
  });

  const mcpRemove = defineTool({
    name: "mcp_remove",
    description: "Disconnect an MCP server and remove its tools.",
    parameters: obj({ name: str() }),
    execute: async (args) => {
      const removed = await host.mcp.remove(args.name);
      return out(removed ? `已移除 MCP ${args.name}。` : `没有找到 MCP ${args.name}。`);
    },
  });

  return [
    createProject,
    listProjects,
    projectStatus,
    messageProject,
    setProjectStatus,
    createTask,
    taskList,
    skillList,
    skillWrite,
    pluginList,
    pluginWrite,
    pluginReload,
    writePersona,
    roleUpsert,
    retryTask,
    indexProject,
    mcpAdd,
    mcpList,
    mcpRemove,
  ];
}

function buildProjectTools(host: RuntimeHost): ToolRegistration[] {
  const createTask = defineTool({
    name: "create_task",
    description:
      "Add a task to the project board. Write a self-contained brief: goal, deliverables, files, acceptance criteria. Then dispatch it.",
    parameters: obj({
      title: str(),
      brief: str(),
      role: opt(str({ description: "Executor role, e.g. 架构师 / 前端 / 后端 / 测试 / 文档" })),
      files: opt(str({ description: "Comma-separated files this task may modify; used for scheduling and review" })),
      dependsOn: opt(str({ description: "Comma-separated task ids that must finish first" })),
    }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      if (scope.project === undefined) return out("当前对话不属于任何项目。");
      const task = host.createTask({
        projectId: scope.project.id,
        title: args.title,
        brief: args.brief,
        role: args.role,
        files: splitList(args.files),
        dependsOn: splitList(args.dependsOn),
      });
      return out(`任务已创建：${formatTask(task)}\n下一步：dispatch_task 或 dispatch_ready。`, { taskId: task.id });
    },
  });

  const dispatchTask = defineTool({
    name: "dispatch_task",
    description:
      "Start one task in the background with a role agent. Returns immediately; the result is reported back as a new message. Tasks run in parallel; file locks serialize edits to the same file.",
    parameters: obj({ taskId: str() }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      const task = host.store.getTaskRecord(args.taskId);
      if (task === undefined) return out(`任务 ${args.taskId} 不存在。`);
      if (scope.project !== undefined && task.projectId !== scope.project.id) {
        return out("不能调度其他项目的任务。");
      }
      try {
        const result = await host.dispatchTask(task.id);
        return out(`任务已派发：${task.title}\n角色对话：${result.roleConversationId}`, {
          taskId: task.id,
          roleConversationId: result.roleConversationId,
        });
      } catch (error) {
        return out(`派发失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  const dispatchReady = defineTool({
    name: "dispatch_ready",
    description: "Dispatch every todo task whose dependencies are done. Use this to run independent tasks in parallel.",
    parameters: obj({}),
    execute: async (_args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      if (scope.project === undefined) return out("当前对话不属于任何项目。");
      const tasks = host.store.listTaskRecords(scope.project.id);
      const statuses = new Map(tasks.map((task) => [task.id, task.status]));
      const ready = tasks.filter(
        (task) =>
          task.status === "todo" && task.dependsOn.every((dependency) => statuses.get(dependency) === "done"),
      );
      if (ready.length === 0) return out("没有可派发的任务。");
      const started: string[] = [];
      const failed: string[] = [];
      for (const task of ready) {
        try {
          await host.dispatchTask(task.id);
          started.push(task.title);
        } catch (error) {
          failed.push(`${task.title}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return out(
        [`已派发 ${started.length} 个任务：`, ...started.map((title) => `- ${title}`), ...(failed.length > 0 ? ["失败：", ...failed] : [])].join("\n"),
      );
    },
  });

  const taskList = defineTool({
    name: "task_list",
    description: "List the project's tasks and their current status.",
    parameters: obj({ status: opt(str({ description: "Optional status filter" })) }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      if (scope.project === undefined) return out("当前对话不属于任何项目。");
      const tasks = host.store
        .listTaskRecords(scope.project.id)
        .filter((task) => args.status === undefined || task.status === args.status);
      if (tasks.length === 0) return out("任务板为空。");
      return out(tasks.map(formatTask).join("\n"));
    },
  });

  const updateTask = defineTool({
    name: "update_task",
    description: "Edit a task's title, brief, role, file scope or dependencies before dispatch.",
    parameters: obj({
      taskId: str(),
      title: opt(str()),
      brief: opt(str()),
      role: opt(str()),
      files: opt(str()),
      dependsOn: opt(str()),
    }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      const task = host.store.getTaskRecord(args.taskId);
      if (task === undefined) return out(`任务 ${args.taskId} 不存在。`);
      if (scope.project !== undefined && task.projectId !== scope.project.id) return out("不能修改其他项目的任务。");
      const updated = host.store.updateTask(task.id, {
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.brief === undefined ? {} : { brief: args.brief }),
        ...(args.role === undefined ? {} : { role: args.role }),
        ...(args.files === undefined ? {} : { files: splitList(args.files) }),
        ...(args.dependsOn === undefined ? {} : { dependsOn: splitList(args.dependsOn) }),
      });
      return out(updated === undefined ? "更新失败。" : `任务已更新：${formatTask(updated)}`);
    },
  });

  const cancelTask = defineTool({
    name: "cancel_task",
    description: "Cancel a queued or running task and abort its role agent.",
    parameters: obj({ taskId: str() }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      const task = host.store.getTaskRecord(args.taskId);
      if (task === undefined) return out(`任务 ${args.taskId} 不存在。`);
      if (scope.project !== undefined && task.projectId !== scope.project.id) return out("不能取消其他项目的任务。");
      await host.cancelTask(task.id);
      return out(`任务已取消：${task.title}`);
    },
  });

  const acceptTask = defineTool({
    name: "accept_task",
    description: "Accept a task after verifying the deliverable. Moves it from review to done.",
    parameters: obj({
      taskId: str(),
      note: opt(str({ description: "Optional acceptance note" })),
    }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      const task = host.store.getTaskRecord(args.taskId);
      if (task === undefined) return out(`任务 ${args.taskId} 不存在。`);
      if (scope.project !== undefined && task.projectId !== scope.project.id) return out("不能验收其他项目的任务。");
      try {
        host.acceptTask(task.id, args.note);
        return out(`已验收通过：${task.title}`);
      } catch (error) {
        return out(`验收失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  const rejectTask = defineTool({
    name: "reject_task",
    description: "Reject a reviewed task and return it to todo with a reason. Use a concrete, actionable note.",
    parameters: obj({
      taskId: str(),
      note: str({ description: "What is wrong and what must change" }),
    }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      const task = host.store.getTaskRecord(args.taskId);
      if (task === undefined) return out(`任务 ${args.taskId} 不存在。`);
      if (scope.project !== undefined && task.projectId !== scope.project.id) return out("不能退回其他项目的任务。");
      try {
        host.rejectTask(task.id, args.note);
        return out(`已退回：${task.title}\n原因：${args.note}\n任务已回到 todo，可重新派发。`);
      } catch (error) {
        return out(`退回失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  const retryTask = defineTool({
    name: "retry_task",
    description: "Retry a failed or cancelled task by putting it back to todo and dispatching a fresh role run.",
    parameters: obj({ taskId: str() }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      const task = host.store.getTaskRecord(args.taskId);
      if (task === undefined) return out(`任务 ${args.taskId} 不存在。`);
      if (scope.project !== undefined && task.projectId !== scope.project.id) return out("不能重试其他项目的任务。");
      try {
        await host.retryTask(task.id);
        return out(`任务已重新派发：${task.title}`);
      } catch (error) {
        return out(`重试失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  const roleUpsert = defineTool({
    name: "role_upsert",
    description: "Create or update a reusable project role definition.",
    parameters: obj({
      name: str(),
      description: str(),
      instructions: str(),
    }),
    execute: async (args) => {
      const role = await host.roles.upsert(args.name, args.description, args.instructions);
      return out(`角色已保存：${role.name}`);
    },
  });

  const messageSystem = defineTool({
    name: "message_system",
    description: "Send a message to the system agent (your supervisor). Use for blockers, scope changes and questions the user must decide.",
    parameters: obj({ message: str() }),
    execute: async (args) => {
      await host.messageSystem(args.message, { entryKind: "yf.project_message" });
      return out("已发送给系统 Agent。");
    },
  });

  const writeSkill = defineTool({
    name: "skill_write",
    description: "Create or update a project skill (SKILL.md) capturing a reusable procedure or project convention.",
    parameters: obj({
      name: str(),
      description: str(),
      body: str(),
      scope: opt(oneOf(["global", "project"])),
    }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      if (scope.project === undefined) return out("当前对话不属于任何项目。");
      const skill = await host.skills.write({
        name: args.name,
        description: args.description,
        body: args.body,
        scope: args.scope ?? "project",
        projectPath: scope.project.path,
      });
      return out(`技能已写入：${skill.path}`);
    },
  });

  const indexProject = defineTool({
    name: "index_project",
    description: "Rescan the project directory and rebuild the file index.",
    parameters: obj({}),
    execute: async (_args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      if (scope.project === undefined) return out("当前对话不属于任何项目。");
      const count = await host.indexProject(scope.project.id);
      return out(`索引完成：${count} 个文件。`);
    },
  });

  const finishProject = defineTool({
    name: "finish_project",
    description: "Mark the project as archived after delivering a final summary to the user and the system agent.",
    parameters: obj({ summary: str() }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      if (scope.project === undefined) return out("当前对话不属于任何项目。");
      const unfinished = host.store
        .listTaskRecords(scope.project.id)
        .filter((task) => task.status !== "done" && task.status !== "cancelled");
      if (unfinished.length > 0) {
        return out(
          `还不能归档：还有 ${unfinished.length} 个任务未完成。\n${unfinished
            .map((task) => `- [${task.id}] ${task.title} · ${task.status}`)
            .join("\n")}`,
        );
      }
      host.store.addMemory({
        scope: scope.project.id,
        kind: "decision",
        title: `项目收尾：${scope.project.name}`,
        body: args.summary,
        source: "project-lead",
        pinned: true,
      });
      host.store.setProjectStatus(scope.project.id, "archived");
      host.notify({
        type: "notification",
        title: `项目完成：${scope.project.name}`,
        body: args.summary.slice(0, 400),
        projectId: scope.project.id,
        taskId: null,
        conversationId: scope.conversationId,
        urgent: false,
        important: true,
      });
      await host.messageSystem(`项目 ${scope.project.name} 已完成：${args.summary}`, { entryKind: "yf.project_done" });
      return out("项目已归档，并已通知系统 Agent。");
    },
  });

  return [
    createTask,
    dispatchTask,
    dispatchReady,
    taskList,
    updateTask,
    cancelTask,
    acceptTask,
    rejectTask,
    retryTask,
    messageSystem,
    writeSkill,
    roleUpsert,
    indexProject,
    finishProject,
  ];
}

function buildRoleTools(host: RuntimeHost): ToolRegistration[] {
  const reportProgress = defineTool({
    name: "report_progress",
    description: "Record a short progress update for the current task. The project lead and the UI see it immediately.",
    parameters: obj({
      note: str({ description: "What has been done and what is next" }),
    }),
    execute: async (args, api) => {
      const scope = host.scopeFor(conversationIdOf(api));
      if (scope.task === undefined) return out("当前对话不是任务角色。");
      host.reportTaskProgress(scope.task.id, args.note);
      return out("进度已记录。");
    },
  });

  return [reportProgress];
}

export interface ExtensionSet {
  coding: Extension;
  fileLocks: Extension;
  guard: Extension;
  shared: Extension;
  system: Extension;
  project: Extension;
  role: Extension;
}

export function createExtensionSet(host: RuntimeHost, promptDeps: PromptDeps): ExtensionSet {
  const lockTool = <T extends ToolRegistration>(tool: T): T =>
    ({
      ...tool,
      execute: async (args: never, api, context) => {
        const rawPath = (args as unknown as { path?: unknown }).path;
        if (typeof rawPath !== "string") return tool.execute(args, api, context);
        const scope = host.scopeFor(String(api.conversationId));
        const release = await host.locks.acquire([rawPath], {
          owner: scope.task === undefined ? `${scope.kind}:${api.conversationId}/${api.callId}` : `task:${scope.task.id}`,
          projectId: scope.project?.id ?? null,
          signal: context.abortSignal,
        });
        try {
          return await tool.execute(args, api, context);
        } finally {
          release();
        }
      },
    }) as T;

  const fileLocks = defineExtension({
    name: "file-locks",
    wraps: [wrapTool(createEditTool(), lockTool), wrapTool(createWriteTool(), lockTool)] as unknown as Wrap<
      ToolRegistration
    >[],
  });

  const guard = defineExtension({
    name: "guard",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api) => {
          if (call.name !== "bash") return undefined;
          const command = typeof call.arguments.command === "string" ? call.arguments.command : "";
          if (!isPrivilegedCommand(command)) return undefined;
          const scope = host.scopeFor(String(api.conversationId));
          if (host.store.hasShellGrant(hashCommand(command), scope.project?.id ?? null)) return undefined;
          return {
            block: `这条命令需要用户批准：${command}\n请先调用 request_approval(kind="shell", title="...", detail="...", command=${JSON.stringify(command)})，等用户批准后再重试。`,
          };
        },
      }),
    ],
  });

  const shared = defineExtension({
    name: "shared-tools",
    sections: sharedSections(promptDeps),
    tools: buildSharedTools(host),
  });

  const system = defineExtension({
    name: "system-tools",
    sections: systemSections(promptDeps),
    tools: buildSystemTools(host),
  });

  const project = defineExtension({
    name: "project-tools",
    sections: projectSections(promptDeps),
    tools: buildProjectTools(host),
  });

  const role = defineExtension({
    name: "role-tools",
    sections: roleSections(promptDeps),
    tools: buildRoleTools(host),
  });

  // Imported lazily to keep the coding tools' image handling out of the way.
  return { coding: CodingTools, fileLocks, guard, shared, system, project, role };
}

export function splitList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const PRIVILEGED_PATTERNS = [
  /\b(npm|pnpm|yarn|bun)\s+(i|install|add|dlx|exec)\b/,
  /\bpip(3)?\s+install\b/,
  /\buv\s+(add|pip\s+install)\b/,
  /\bpoetry\s+add\b/,
  /\bcargo\s+install\b/,
  /\bgo\s+install\b/,
  /\bbrew\s+(install|upgrade|tap)\b/,
  /\b(apt|apt-get|yum|dnf|apk)\s+(install|add)\b/,
  /\bgit\s+clone\b/,
  /\bdocker\s+(pull|run)\b/,
  /\bcurl\b[\s\S]*\|\s*(sh|bash|zsh)\b/,
  /\bwget\b[\s\S]*\|\s*(sh|bash|zsh)\b/,
  /\bsudo\b/,
  /\bnpx\s+/,
];

function htmlToText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function isPrivilegedCommand(command: string): boolean {
  return PRIVILEGED_PATTERNS.some((pattern) => pattern.test(command));
}
