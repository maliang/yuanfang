import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { defineExtension, defineTool, type Extension, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";

export interface McpServerConfig {
  /** stdio server command; omit when url is set. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Streamable HTTP server endpoint. */
  url?: string;
  headers?: Record<string, string>;
  /** Restrict tools to these project ids; empty/absent means every project. */
  projects?: string[];
  enabled?: boolean;
}

interface McpConfigFile {
  servers: Record<string, McpServerConfig>;
}

export interface McpServerInfo {
  name: string;
  command: string;
  args: string[];
  url: string | null;
  projects: string[];
  connected: boolean;
  tools: Array<{ name: string; description: string }>;
  error: string | null;
}

interface InstalledServer {
  name: string;
  config: McpServerConfig;
  client: McpClient;
  extension: Extension;
  tools: Array<{ name: string; description: string }>;
  error: string | null;
}

export class McpService {
  readonly #file: string;
  readonly #registry: () => Registry;
  readonly #log: (level: "info" | "warn" | "error", message: string) => void;
  readonly #projectForConversation: (conversationId: string) => string | null;
  readonly #servers = new Map<string, InstalledServer>();

  constructor(
    file: string,
    registry: () => Registry,
    log: (level: "info" | "warn" | "error", message: string) => void,
    projectForConversation: (conversationId: string) => string | null,
  ) {
    this.#file = file;
    this.#registry = registry;
    this.#log = log;
    this.#projectForConversation = projectForConversation;
  }

  async list(): Promise<McpServerInfo[]> {
    const config = await this.#readConfig();
    return Object.entries(config.servers).map(([name, server]) => {
      const installed = this.#servers.get(name);
      return {
        name,
        command: server.command ?? "",
        args: server.args ?? [],
        url: server.url ?? null,
        projects: server.projects ?? [],
        connected: installed !== undefined && installed.error === null,
        tools: installed?.tools ?? [],
        error: installed?.error ?? null,
      };
    });
  }

  async loadAll(): Promise<void> {
    const config = await this.#readConfig();
    for (const [name, server] of Object.entries(config.servers)) {
      if (server.enabled === false) continue;
      await this.install(name, server).catch((error: unknown) => {
        this.#log("warn", `MCP ${name} 连接失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  async install(name: string, config: McpServerConfig): Promise<McpServerInfo> {
    const existing = this.#servers.get(name);
    if (existing !== undefined) await this.remove(name, false);
    if ((config.url ?? "").trim().length === 0 && (config.command ?? "").trim().length === 0) {
      throw new Error("MCP 需要 command 或 url");
    }
    const transport =
      config.url !== undefined && config.url.trim().length > 0
        ? new StreamableHttpTransport({ url: config.url, ...(config.headers === undefined ? {} : { headers: config.headers }) })
        : new StdioTransport({
            command: config.command ?? "",
            ...(config.args === undefined ? {} : { args: config.args }),
            ...(config.env === undefined ? {} : { env: config.env }),
            ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
            inheritEnv: true,
            stderr: "pipe",
            onStderr: (chunk) => {
              const text = chunk.trim();
              if (text.length > 0) this.#log("info", `[mcp:${name}] ${text.slice(0, 500)}`);
            },
          });
    const client = new McpClient({ name: "yuanfang", version: "0.1.0", requestTimeoutMs: 60_000 });
    const server: InstalledServer = {
      name,
      config,
      client,
      extension: defineExtension({ name: `mcp-${sanitize(name)}`, tools: [] }),
      tools: [],
      error: null,
    };
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const registrations: ToolRegistration[] = tools.map((tool) => {
        const toolName = `mcp_${sanitize(name)}_${sanitize(tool.name)}`.slice(0, 64);
        const schema = {
          ...tool.inputSchema,
          type: "object" as const,
          properties:
            tool.inputSchema.properties !== null && typeof tool.inputSchema.properties === "object"
              ? tool.inputSchema.properties
              : {},
        };
        return defineTool({
          name: toolName,
          description: `${tool.description ?? tool.name}（MCP 服务：${name}）`,
          parameters: schema as object,
          replay: "unsafe",
          execute: async (args: unknown, api, context) => {
            const allowedProjects = config.projects ?? [];
            if (allowedProjects.length > 0) {
              const projectId = this.#projectForConversation(String(api.conversationId));
              if (projectId !== null && !allowedProjects.includes(projectId)) {
                return {
                  output: [{ type: "text", text: `MCP ${name} 未授权给当前项目。` }],
                  isError: true,
                };
              }
            }
            const result = await client.callTool(tool.name, (args ?? {}) as Record<string, unknown>, {
              signal: context.abortSignal,
            });
            return {
              output: toLlmContent(result) as never,
              isError: result.isError === true,
            };
          },
        });
      });
      const extension = defineExtension({ name: `mcp-${sanitize(name)}`, tools: registrations });
      server.extension = extension;
      server.tools = registrations.map((registration, index) => ({
        name: registration.name,
        description: tools[index]?.description ?? "",
      }));
      this.#registry().install(extension);
      this.#servers.set(name, server);
      await this.#writeServer(name, { ...config, enabled: true });
      this.#log("info", `MCP ${name} 已连接，${registrations.length} 个工具`);
      return {
        name,
        command: config.command ?? "",
        args: config.args ?? [],
        url: config.url ?? null,
        projects: config.projects ?? [],
        connected: true,
        tools: server.tools,
        error: null,
      };
    } catch (error) {
      server.error = error instanceof Error ? error.message : String(error);
      this.#servers.set(name, server);
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async remove(name: string, persist = true): Promise<boolean> {
    const server = this.#servers.get(name);
    if (server !== undefined) {
      this.#registry().uninstall(server.extension);
      await server.client.close().catch(() => undefined);
      this.#servers.delete(name);
    }
    if (persist) {
      const config = await this.#readConfig();
      delete config.servers[name];
      await this.#writeConfig(config);
    }
    return server !== undefined;
  }

  async close(): Promise<void> {
    for (const server of this.#servers.values()) {
      await server.client.close().catch(() => undefined);
    }
    this.#servers.clear();
  }

  async #readConfig(): Promise<McpConfigFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#file, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { servers: {} };
      const servers = (parsed as { servers?: unknown }).servers;
      if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return { servers: {} };
      return { servers: servers as Record<string, McpServerConfig> };
    } catch {
      return { servers: {} };
    }
  }

  async #writeConfig(config: McpConfigFile): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
    await rename(temporary, this.#file);
  }

  async #writeServer(name: string, config: McpServerConfig): Promise<void> {
    const current = await this.#readConfig();
    current.servers[name] = config;
    await this.#writeConfig(current);
  }
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
}
