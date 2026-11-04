import { fork, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineExtension, defineTool, section, type Extension, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";
import type { PluginInfo } from "@yuanfang/shared";

const HOST_PATH = fileURLToPath(new URL("./plugin-host.js", import.meta.url));

function quickjsWasmPath(): string {
  try {
    return fileURLToPath(import.meta.resolve("quickjs-wasi/quickjs.wasm"));
  } catch {
    return createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm");
  }
}
const PLUGIN_TEMPLATE = `// Sandboxed Yuanfang plugin. Runs in a child process with Node's permission model.
export const name = "my-plugin";
export const description = "What this plugin does";
export const permissions = ["projects:read"]; // optional: projects:read, projects:write, net, exec, env:NAME

export async function activate(ctx) {
  const tool = ctx.pi.defineTool({
    name: "my_plugin_tool",
    description: "What it does",
    parameters: ctx.pi.schema.obj({ text: ctx.pi.schema.str() }),
    execute: async (args, api) => {
      // ctx.app.readProjectFile(path) / writeProjectFile / listProjectFiles
      // with declared permissions; no direct fs/net access by default.
      return { output: [{ type: "text", text: args.text }] };
    },
  });
  ctx.install(ctx.pi.defineExtension({ name: "my-plugin", tools: [tool] }));
}
`;

interface PluginMeta {
  permissions: string[];
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ChildRecord {
  name: string;
  file: string;
  meta: PluginMeta;
  child: ChildProcess;
  extension: Extension | null;
  pending: Map<string, PendingCall>;
  error: string | null;
  ready: boolean;
}

export interface PluginServiceOptions {
  directory: string;
  workspace: string;
  projectsDir: string;
  projectRootForConversation: (conversationId: string) => string | null;
  projectRoots: () => string[];
  notify: (title: string, body: string) => void;
  registry: () => Registry;
  log: (level: "info" | "warn" | "error", message: string) => void;
}

export class PluginService {
  readonly #options: PluginServiceOptions;
  readonly #children = new Map<string, ChildRecord>();
  readonly #meta = new Map<string, PluginMeta>();

  constructor(options: PluginServiceOptions) {
    this.#options = options;
  }

  async list(): Promise<PluginInfo[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.#options.directory)).filter((name) => name.endsWith(".mjs"));
    } catch {
      return [];
    }
    const results: PluginInfo[] = [];
    for (const name of names) {
      const base = name.replace(/\.mjs$/, "");
      const file = join(this.#options.directory, name);
      let updatedAt = 0;
      try {
        updatedAt = Math.floor((await stat(file)).mtimeMs);
      } catch {
        // Ignore.
      }
      const record = this.#children.get(base);
      const meta = await this.#readMeta(base);
      results.push({
        name: base,
        description: record?.extension === null ? "" : (record?.extension?.sections?.length ?? 0) > 0 ? "sandboxed plugin" : "sandboxed plugin",
        path: file,
        enabled: true,
        loaded: record !== undefined && record.error === null && record.ready,
        error: record?.error ?? null,
        updatedAt,
        permissions: meta.permissions,
        sandboxed: true,
      });
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  async loadAll(): Promise<void> {
    let names: string[] = [];
    try {
      names = (await readdir(this.#options.directory)).filter((name) => name.endsWith(".mjs"));
    } catch {
      return;
    }
    for (const name of names) {
      await this.reload(name.replace(/\.mjs$/, "")).catch((error: unknown) => {
        this.#options.log("warn", `plugin ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  async save(name: string, code: string, permissions: string[] = []): Promise<PluginInfo> {
    const base = sanitize(name);
    await mkdir(this.#options.directory, { recursive: true });
    const file = join(this.#options.directory, `${base}.mjs`);
    await writeFile(file, code, "utf8");
    await writeFile(
      join(this.#options.directory, `${base}.json`),
      JSON.stringify({ permissions: [...new Set(permissions)] }, null, 2),
      { mode: 0o600 },
    );
    this.#meta.set(base, { permissions: [...new Set(permissions)] });
    return {
      name: base,
      description: "",
      path: file,
      enabled: true,
      loaded: false,
      error: null,
      updatedAt: Date.now(),
      permissions: [...new Set(permissions)],
      sandboxed: true,
    };
  }

  async write(name: string, code: string, permissions: string[] = []): Promise<PluginInfo> {
    const info = await this.save(name, code, permissions);
    return this.reload(info.name);
  }

  async reload(name: string): Promise<PluginInfo> {
    const base = sanitize(name.replace(/\.mjs$/, ""));
    const file = join(this.#options.directory, `${base}.mjs`);
    const info = await stat(file);
    const meta = await this.#readMeta(base);
    const previous = this.#children.get(base);
    if (previous !== undefined) await this.#stop(previous);
    const childInfo = await this.#spawn(base, file, meta);
    this.#children.set(base, childInfo);
    return {
      name: base,
      description: "",
      path: file,
      enabled: true,
      loaded: childInfo.ready && childInfo.error === null,
      error: childInfo.error,
      updatedAt: Math.floor(info.mtimeMs),
      permissions: meta.permissions,
      sandboxed: true,
    };
  }

  async remove(name: string): Promise<boolean> {
    const base = sanitize(name.replace(/\.mjs$/, ""));
    const record = this.#children.get(base);
    if (record !== undefined) await this.#stop(record);
    this.#children.delete(base);
    this.#meta.delete(base);
    await rm(join(this.#options.directory, `${base}.mjs`), { force: true }).catch(() => undefined);
    await rm(join(this.#options.directory, `${base}.json`), { force: true }).catch(() => undefined);
    return record !== undefined;
  }

  async close(): Promise<void> {
    for (const record of this.#children.values()) await this.#stop(record);
    this.#children.clear();
  }

  template(): string {
    return PLUGIN_TEMPLATE;
  }

  async #readMeta(base: string): Promise<PluginMeta> {
    const cached = this.#meta.get(base);
    if (cached !== undefined) return cached;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.#options.directory, `${base}.json`), "utf8"));
      const permissions =
        parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { permissions?: unknown }).permissions)
          ? (parsed as { permissions: unknown[] }).permissions.filter((item): item is string => typeof item === "string")
          : [];
      const meta = { permissions };
      this.#meta.set(base, meta);
      return meta;
    } catch {
      return { permissions: [] };
    }
  }

  async #spawn(name: string, file: string, meta: PluginMeta): Promise<ChildRecord> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      TZ: process.env.TZ,
      YUANFANG_PLUGIN: "1",
      YUANFANG_PLUGIN_FILE: file,
      YUANFANG_QUICKJS_WASM: quickjsWasmPath(),
      ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
    };
    for (const permission of meta.permissions) {
      if (permission.startsWith("env:") && process.env[permission.slice(4)] !== undefined) {
        env[permission.slice(4)] = process.env[permission.slice(4)];
      }
    }
    const child = fork(HOST_PATH, [], {
      execPath: process.execPath,
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const record: ChildRecord = {
      name,
      file,
      meta,
      child,
      extension: null,
      pending: new Map(),
      error: null,
      ready: false,
    };
    child.stdout?.on("data", (chunk) => this.#options.log("info", `[plugin:${name}] ${String(chunk).slice(0, 500)}`));
    child.stderr?.on("data", (chunk) => this.#options.log("warn", `[plugin:${name}] ${String(chunk).slice(0, 500)}`));
    child.on("message", (message: Record<string, unknown>) => {
      void this.#onMessage(record, message);
    });
    child.on("error", (error) => {
      record.error = error.message;
      this.#rejectPending(record, error.message);
    });
    child.on("exit", (code) => {
      if (record.error === null && code !== 0) record.error = `plugin process exited (${code})`;
      this.#rejectPending(record, record.error ?? "plugin process exited");
      if (record.extension !== null) {
        this.#options.registry().uninstall(record.extension);
        record.extension = null;
      }
      record.ready = false;
    });
    child.send({ type: "activate", file });
    return record;
  }

  async #onMessage(record: ChildRecord, message: Record<string, unknown>): Promise<void> {
    const type = typeof message.type === "string" ? message.type : "";
    if (type === "ready") {
      record.ready = true;
      const manifest = message.manifest as Array<{
        name: string;
        tools: Array<{ name: string; description: string; parameters: object }>;
        sections: Array<{ key: string; tag: boolean }>;
      }>;
      const tools: ToolRegistration[] = [];
      for (const extension of manifest) {
        for (const tool of extension.tools) {
          tools.push(
            defineTool({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters as object,
              replay: "unsafe",
              execute: async (args, api, context) => {
                const projectRoot = this.#options.projectRootForConversation(String(api.conversationId));
                const result = (await this.#call(record, "tool", {
                  id: `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                  name: tool.name,
                  args: args as never,
                  projectRoot,
                }, context.abortSignal)) as {
                  output?: unknown;
                  isError?: boolean;
                  details?: unknown;
                };
                return {
                  output: (result.output ?? [{ type: "text", text: "" }]) as never,
                  isError: result.isError === true,
                  ...(result.details === null || result.details === undefined ? {} : { details: result.details as never }),
                };
              },
            }),
          );
        }
      }
      const sections = manifest.flatMap((extension) =>
        extension.sections.map((item) =>
          section(
            `${record.name}:${item.key}`,
            async (input) => {
              const result = (await this.#call(record, "section", {
                id: `section-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                key: item.key,
                input: { conversationId: String(input.conversationId), cwd: input.agent.cwd ?? null },
              }, undefined)) as { value?: string };
              return result.value ?? "";
            },
            { tag: item.tag },
          ),
        ),
      );
      record.extension = defineExtension({
        name: `sandbox-${record.name}`,
        tools,
        sections,
      });
      this.#options.registry().install(record.extension);
      this.#options.log("info", `plugin ${record.name} loaded in sandboxed child (${tools.length} tools)`);
      return;
    }
    if ((type === "tool_result" || type === "section_result" || type === "rpc_result") && typeof message.id === "string") {
      const pending = record.pending.get(message.id);
      if (pending === undefined) return;
      record.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (typeof message.error === "string") pending.reject(new Error(message.error));
      else pending.resolve(message);
      return;
    }
    if (type === "host_call" && typeof message.id === "string" && typeof message.method === "string") {
      try {
        const value = await this.#hostCall(record, message);
        record.child.send({ type: "rpc_result", id: message.id, value });
      } catch (error) {
        record.child.send({
          type: "rpc_result",
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (type === "log" && typeof message.message === "string") {
      this.#options.log("info", `[plugin:${record.name}] ${message.message.slice(0, 500)}`);
    }
    if (type === "fatal" && typeof message.error === "string") {
      record.error = message.error;
      this.#options.log("error", `plugin ${record.name} failed: ${message.error}`);
    }
  }

  async #hostCall(record: ChildRecord, message: Record<string, unknown>): Promise<unknown> {
    const method = String(message.method);
    const args = (message.args ?? {}) as Record<string, unknown>;
    if (method === "notify") {
      this.#options.notify(String(args.title ?? "插件"), String(args.body ?? ""));
      return null;
    }
    if (method === "readProjectFile" || method === "writeProjectFile" || method === "listProjectFiles") {
      if (!record.meta.permissions.includes("projects:read") && method !== "writeProjectFile") {
        throw new Error("插件没有 projects:read 权限");
      }
      if (method === "writeProjectFile" && !record.meta.permissions.includes("projects:write")) {
        throw new Error("插件没有 projects:write 权限");
      }
      const root = typeof message.projectRoot === "string" ? resolve(message.projectRoot) : null;
      if (root === null) throw new Error("当前调用没有项目工作区，不能访问文件");
      const allowedRoot = this.#options
        .projectRoots()
        .map((candidate) => resolve(candidate))
        .some((candidate) => candidate === root);
      if (!allowedRoot) throw new Error("项目工作区不在允许列表中");
      if (method === "listProjectFiles") {
        const entries = await readdir(root, { withFileTypes: true });
        return entries.map((entry) => entry.name);
      }
      const requested = String(args.path ?? "");
      const absolute = resolve(root, requested);
      const relativePath = relative(root, absolute);
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("路径不能越出项目工作区");
      if (method === "readProjectFile") return await readFile(absolute, "utf8");
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, String(args.content ?? ""), "utf8");
      return null;
    }
    throw new Error(`unsupported host method ${method}`);
  }

  #call(
    record: ChildRecord,
    type: string,
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    return new Promise((resolvePromise, reject) => {
      if (record.error !== null) {
        reject(new Error(record.error));
        return;
      }
      const id = String(payload.id ?? `${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const timer = setTimeout(() => {
        record.pending.delete(id);
        reject(new Error(`sandboxed plugin timed out after 120s`));
      }, 120_000);
      record.pending.set(id, { resolve: resolvePromise, reject, timer });
      const onAbort = () => {
        const pending = record.pending.get(id);
        if (pending === undefined) return;
        record.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error("sandboxed plugin call aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      record.child.send({ type, ...payload, id });
    });
  }

  #rejectPending(record: ChildRecord, message: string): void {
    for (const pending of record.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    record.pending.clear();
  }

  async #stop(record: ChildRecord): Promise<void> {
    if (record.extension !== null) this.#options.registry().uninstall(record.extension);
    record.extension = null;
    this.#rejectPending(record, "plugin stopped");
    record.child.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        record.child.kill("SIGKILL");
        resolvePromise();
      }, 2_000);
      record.child.once("exit", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }
}

function sanitize(value: string): string {
  return value.replace(/\.mjs$/, "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
}

export { ToolRegistration };
