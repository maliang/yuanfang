/**
 * Sandboxed plugin host.
 *
 * This file runs in a child process, but plugin code itself executes inside a
 * QuickJS WebAssembly VM with a clean global object: no process, require, fs,
 * network, or timers other than the ones we provide. The host only forwards
 * explicit RPC capabilities (project file access, notify, log).
 */
import { readFile } from "node:fs/promises";
import { QuickJS, EvalFlags } from "quickjs-wasi";

type RpcPromise = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const pending = new Map<string, RpcPromise>();
let rpcSeq = 0;

function sendRpc(type: string, payload: Record<string, unknown>): Promise<unknown> {
  const id = `rpc-${++rpcSeq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send?.({ type, id, ...payload });
  });
}

async function main(): Promise<void> {
  const file = process.env.YUANFANG_PLUGIN_FILE;
  const wasmPath = process.env.YUANFANG_QUICKJS_WASM;
  if (file === undefined || wasmPath === undefined) throw new Error("plugin host is missing its paths");
  const wasm = await readFile(wasmPath);
  const vm = await QuickJS.create({
    wasm,
    moduleLoader: {
      load: (name: string) => {
        throw new Error(`sandboxed plugins cannot import modules (${name})`);
      },
      normalize: (_base: string, specifier: string) => specifier,
    },
  });

  const hostCall = vm.newFunction("__yf_host_call", (methodHandle, argsHandle, rootHandle) => {
    const deferred = vm.newPromise();
    const method = methodHandle.toString();
    const args = argsHandle.toString();
    const projectRoot = rootHandle.toString();
    const id = `host-${++rpcSeq}`;
    pending.set(id, {
      resolve: (value) => {
        deferred.resolve(vm.hostToHandle(value));
        vm.executePendingJobs();
      },
      reject: (error) => {
        deferred.reject(vm.newError(error));
        vm.executePendingJobs();
      },
    });
    process.send?.({
      type: "host_call",
      id,
      method,
      args: JSON.parse(args || "{}"),
      projectRoot: projectRoot || null,
    });
    return deferred.handle;
  });
  vm.setProp(vm.global, "__yf_host_call", hostCall);

  const prelude = String.raw`
    globalThis.__yf_tools = {};
    globalThis.__yf_sections = {};
    globalThis.__yf_extensions = [];
    globalThis.__yf_current_root = "";
    globalThis.__yf_last_output = [];
    globalThis.__yf_last_details = null;
    globalThis.__yf_log = function (message) { return __yf_host_call("log", JSON.stringify({ message: String(message) }), ""); };
    globalThis.__yf_notify = function (title, body) {
      return __yf_host_call("notify", JSON.stringify({ title: String(title), body: String(body) }), "");
    };
    globalThis.__yf_schema = {
      opt: (inner) => ({ ...inner, __optional: true }),
      obj: (props) => {
        const properties = {};
        const required = [];
        for (const [key, value] of Object.entries(props || {})) {
          const copy = { ...value };
          if (copy.__optional) delete copy.__optional; else required.push(key);
          properties[key] = copy;
        }
        return { type: "object", properties, ...(required.length ? { required } : {}) };
      },
      str: (options) => ({ type: "string", ...(options || {}) }),
      num: (options) => ({ type: "number", ...(options || {}) }),
      int: (options) => ({ type: "integer", ...(options || {}) }),
      bool: (options) => ({ type: "boolean", ...(options || {}) }),
      arr: (items, options) => ({ type: "array", items, ...(options || {}) }),
      oneOf: (values) => ({ type: "string", enum: values }),
    };
    globalThis.__yf_defineTool = (tool) => {
      __yf_tools[tool.name] = tool;
      return tool;
    };
    globalThis.__yf_defineExtension = (extension) => extension;
    globalThis.__yf_section = (key, render, options) => {
      const item = { key, render, tag: !(options && options.tag === false) };
      __yf_sections[key] = item;
      return item;
    };
    globalThis.__yf_install = (extension) => { __yf_extensions.push(extension); };
    globalThis.__yf_ctx = {
      pi: {
        defineTool: __yf_defineTool,
        defineExtension: __yf_defineExtension,
        section: __yf_section,
        wrapTool: () => { throw new Error("sandboxed plugins cannot wrap tools"); },
        schema: __yf_schema,
      },
      install: __yf_install,
      log: __yf_log,
      app: {
        log: __yf_log,
        notify: __yf_notify,
        readProjectFile: (path) => __yf_host_call("readProjectFile", JSON.stringify({ path: String(path) }), __yf_current_root),
        writeProjectFile: (path, content) => __yf_host_call("writeProjectFile", JSON.stringify({ path: String(path), content: String(content) }), __yf_current_root),
        listProjectFiles: () => __yf_host_call("listProjectFiles", "{}", __yf_current_root),
      },
    };
    globalThis.__yf_manifest = () => {
      const all = __yf_extensions.length > 0
        ? [...__yf_extensions]
        : [{ name: "default", tools: Object.values(__yf_tools), sections: Object.values(__yf_sections) }];
      return all.map((extension) => ({
        name: extension.name,
        tools: (extension.tools || []).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
        sections: (extension.sections || []).map((section) => ({ key: section.key, tag: section.tag })),
      }));
    };
    globalThis.__yf_call_tool = async (name, argsJson, projectRoot) => {
      __yf_current_root = projectRoot || "";
      __yf_last_output = [];
      __yf_last_details = null;
      const tool = __yf_tools[name];
      if (!tool) throw new Error("unknown sandboxed tool " + name);
      const args = JSON.parse(argsJson || "{}");
      const api = {
        output: (chunk) => { __yf_last_output.push(String(chunk)); },
        details: (value) => { __yf_last_details = value; },
        diagnostic: () => {},
        retainedOutput: () => ({ text: __yf_last_output.join(""), truncated: false }),
        memo: async () => { throw new Error("memo is not available in a sandboxed plugin"); },
        commit: async () => { throw new Error("store commits are not available in a sandboxed plugin"); },
        env: undefined,
        models: undefined,
        agent: async () => ({}),
        conversation: async () => undefined,
        executeTool: async () => { throw new Error("nested tools are not available in a sandboxed plugin"); },
        createTask: async () => { throw new Error("tasks are not available in a sandboxed plugin"); },
        getTask: async () => undefined,
        waitForTask: async () => { throw new Error("tasks are not available in a sandboxed plugin"); },
        snapshot: async () => undefined,
        watchDoc: async () => undefined,
        observeDoc: async () => undefined,
      };
      const result = await tool.execute(args, api, {});
      const output = result && result.output ? result.output : [{ type: "text", text: __yf_last_output.join("") }];
      return JSON.stringify({
        output,
        isError: !!(result && result.isError),
        details: result && result.details !== undefined ? result.details : __yf_last_details,
      });
    };
    globalThis.__yf_call_section = async (key, inputJson) => {
      const item = __yf_sections[key];
      if (!item) throw new Error("unknown section " + key);
      return String(await item.render(JSON.parse(inputJson || "{}"), {}));
    };
  `;
  vm.evalCode(prelude, "<yuanfang-plugin-prelude>");
  vm.executePendingJobs();

  const source = await readFile(file, "utf8");
  const modulePromise = vm.evalCode(source, file, EvalFlags.TYPE_MODULE);
  vm.executePendingJobs();
  const namespaceResult = await vm.resolvePromise(modulePromise);
  if ("error" in namespaceResult) throw new Error(namespaceResult.error.consume((error) => error.toString()));
  const namespace = namespaceResult.value;
  const activate = namespace.getProp("activate");
  const defaultExport = namespace.getProp("default");
  const ctxHandle = vm.global.getProp("__yf_ctx");
  const fn = activate.isFunction ? activate : defaultExport.isFunction ? defaultExport : undefined;
  if (fn === undefined) throw new Error("plugin must export activate() or a default function");
  const activation = vm.callFunction(fn, vm.global, ctxHandle);
  if (activation.isPromise) {
    vm.executePendingJobs();
    const settled = await vm.resolvePromise(activation);
    if ("error" in settled) throw new Error(settled.error.consume((error) => error.toString()));
  }
  const permissions = namespace.getProp("permissions");
  const manifest = vm.evalCode("JSON.stringify(__yf_manifest())").consume((value) => value.toString());
  const permissionList = permissions.isUndefined
    ? []
    : JSON.parse(permissions.consume((value) => value.toString()) || "[]");
  process.send?.({
    type: "ready",
    manifest: JSON.parse(manifest),
    permissions: permissionList,
  });

  process.on("message", (message: Record<string, unknown>) => {
    if (typeof message.type !== "string" || typeof message.id !== "string") return;
    if (message.type === "rpc_result") {
      const waiter = pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id);
      if (typeof message.error === "string") waiter.reject(new Error(message.error));
      else waiter.resolve(message.value);
      return;
    }
    if (message.type === "tool" && typeof message.name === "string") {
      const args = JSON.stringify(message.args ?? {});
      const root = JSON.stringify(message.projectRoot ?? "");
      const promise = vm.evalCode(
        `__yf_call_tool(${JSON.stringify(message.name)}, ${JSON.stringify(args)}, ${root})`,
      );
      vm.executePendingJobs();
      void vm.resolvePromise(promise).then((result) => {
        if ("error" in result) {
          process.send?.({
            type: "tool_result",
            id: message.id,
            output: [{ type: "text", text: result.error.consume((error) => error.toString()) }],
            isError: true,
            details: null,
          });
        } else {
          const payload = JSON.parse(result.value.consume((value) => value.toString()));
          process.send?.({ type: "tool_result", id: message.id, ...payload });
        }
      });
      return;
    }
    if (message.type === "section" && typeof message.key === "string") {
      const input = JSON.stringify(message.input ?? {});
      const promise = vm.evalCode(`__yf_call_section(${JSON.stringify(message.key)}, ${JSON.stringify(input)})`);
      vm.executePendingJobs();
      void vm.resolvePromise(promise).then((result) => {
        if ("error" in result) {
          process.send?.({ type: "rpc_result", id: message.id, error: result.error.consume((error) => error.toString()) });
        } else {
          process.send?.({ type: "section_result", id: message.id, value: result.value.consume((value) => value.toString()) });
        }
      });
    }
  });
}

process.on("uncaughtException", (error) => {
  process.send?.({ type: "fatal", error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  process.send?.({ type: "fatal", error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});

void main().catch((error) => {
  process.send?.({ type: "fatal", error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
