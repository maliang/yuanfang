import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defineExtension,
  defineTool,
  section,
  wrapTool,
  type Extension,
  type Registry,
} from "@earendil-works/pi-durable";
import { bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { PluginInfo } from "@yuanfang/shared";

export interface PluginContext {
  name: string;
  description: string;
  /** pi-durable primitives, so plugins do not need to resolve node_modules. */
  pi: {
    defineExtension: typeof defineExtension;
    defineTool: typeof defineTool;
    section: typeof section;
    wrapTool: typeof wrapTool;
    schema: { obj: typeof obj; str: typeof str; num: typeof num; bool: typeof bool; opt: typeof opt; oneOf: typeof oneOf };
  };
  /** Install an extension in the live registry. Idempotent by extension name. */
  install(extension: Extension): void;
  log(message: string): void;
  /** Host services a plugin may use. Shape is intentionally loose; plugins are trusted code. */
  app: Record<string, unknown>;
}

interface LoadedPlugin {
  file: string;
  name: string;
  description: string;
  extensions: string[];
  extensionObjects: Extension[];
  error: string | null;
  updatedAt: number;
}

const PLUGIN_TEMPLATE = `// Yuanfang plugin. Activated in the main process; trusted code.
export const name = "my-plugin";
export const description = "What this plugin does";
export async function activate(ctx) {
  // const tool = ctx.pi.defineTool({ ... });
  // ctx.install(ctx.pi.defineExtension({ name: "my-plugin", tools: [tool] }));
}
`;

export class PluginService {
  readonly #directory: string;
  readonly #registry: () => Registry;
  readonly #app: () => Record<string, unknown>;
  readonly #loaded = new Map<string, LoadedPlugin>();
  readonly #log: (message: string) => void;

  constructor(directory: string, registry: () => Registry, app: () => Record<string, unknown>, log: (message: string) => void) {
    this.#directory = directory;
    this.#registry = registry;
    this.#app = app;
    this.#log = log;
  }

  async list(): Promise<PluginInfo[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.#directory)).filter((name) => name.endsWith(".mjs"));
    } catch {
      return [];
    }
    const results: PluginInfo[] = [];
    for (const name of names) {
      const file = join(this.#directory, name);
      let description = "";
      let updatedAt = 0;
      let error: string | null = null;
      try {
        const info = await stat(file);
        updatedAt = Math.floor(info.mtimeMs);
        const raw = await readFile(file, "utf8");
        const match = /export\s+const\s+description\s*=\s*["'`]([^"'`]*)["'`]/.exec(raw);
        description = match?.[1] ?? "";
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const base = name.replace(/\.mjs$/, "");
      const loaded = this.#loaded.get(base);
      results.push({
        name: base,
        description: description.length > 0 ? description : (loaded?.description ?? ""),
        path: file,
        enabled: true,
        loaded: loaded !== undefined && loaded.error === null,
        error: loaded?.error ?? error,
        updatedAt,
      });
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  async loadAll(): Promise<void> {
    let names: string[] = [];
    try {
      names = (await readdir(this.#directory)).filter((name) => name.endsWith(".mjs"));
    } catch {
      return;
    }
    for (const name of names) {
      await this.reload(name.replace(/\.mjs$/, "")).catch((error: unknown) => {
        this.#log(`plugin ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  async reload(name: string): Promise<PluginInfo> {
    const base = name.replace(/\.mjs$/, "").replace(/[^a-zA-Z0-9_-]/g, "-");
    const file = join(this.#directory, `${base}.mjs`);
    const info = await stat(file);
    const previous = this.#loaded.get(base);
    if (previous !== undefined) {
      for (const extension of previous.extensionObjects) {
        this.#registry().uninstall(extension);
      }
    }
    const loaded: LoadedPlugin = {
      file,
      name: base,
      description: "",
      extensions: [],
      extensionObjects: [],
      error: null,
      updatedAt: Math.floor(info.mtimeMs),
    };
    try {
      const url = `${pathToFileURL(file).href}?v=${info.mtimeMs}-${Date.now()}`;
      const module = (await import(url)) as {
        name?: string;
        description?: string;
        activate?: (context: PluginContext) => void | Promise<void>;
        default?: ((context: PluginContext) => void | Promise<void>) | { activate?: (context: PluginContext) => void | Promise<void> };
      };
      loaded.name = module.name ?? base;
      loaded.description = module.description ?? "";
      const activate =
        module.activate ??
        (typeof module.default === "function" ? module.default : module.default?.activate);
      if (activate === undefined) throw new Error("plugin must export activate() or default function");
      const context: PluginContext = {
        name: loaded.name,
        description: loaded.description,
        pi: {
          defineExtension,
          defineTool,
          section,
          wrapTool,
          schema: { obj, str, num, bool, opt, oneOf },
        },
        install: (extension: Extension) => {
          this.#registry().install(extension);
          loaded.extensions.push(extension.name);
          loaded.extensionObjects.push(extension);
        },
        log: (message: string) => this.#log(`[plugin:${loaded.name}] ${message}`),
        app: this.#app(),
      };
      await activate(context);
      this.#log(`plugin ${loaded.name} loaded (${loaded.extensions.length} extensions)`);
    } catch (caught) {
      loaded.error = caught instanceof Error ? caught.message : String(caught);
      this.#log(`plugin ${base} error: ${loaded.error}`);
    }
    this.#loaded.set(base, loaded);
    return {
      name: loaded.name,
      description: loaded.description,
      path: file,
      enabled: true,
      loaded: loaded.error === null,
      error: loaded.error,
      updatedAt: loaded.updatedAt,
    };
  }

  async remove(name: string): Promise<boolean> {
    const base = name.replace(/\.mjs$/, "").replace(/[^a-zA-Z0-9_-]/g, "-");
    const server = this.#loaded.get(base);
    if (server !== undefined) {
      for (const extension of server.extensionObjects) this.#registry().uninstall(extension);
      this.#loaded.delete(base);
    }
    try {
      await rm(join(this.#directory, `${base}.mjs`), { force: true });
      return true;
    } catch {
      return server !== undefined;
    }
  }

  async write(name: string, code: string): Promise<PluginInfo> {
    const base = name.replace(/\.mjs$/, "").replace(/[^a-zA-Z0-9_-]/g, "-");
    const file = join(this.#directory, `${base}.mjs`);
    await writeFile(file, code, "utf8");
    return this.reload(base);
  }

  template(): string {
    return PLUGIN_TEMPLATE;
  }
}

