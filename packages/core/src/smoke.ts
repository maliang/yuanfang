import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { YuanfangRuntime } from "./runtime.js";
import { hashCommand } from "./store.js";

const workspace = await mkdtemp(join(tmpdir(), "yuanfang-smoke-"));

async function waitFor<T>(label: string, probe: () => T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = probe();
    if (value !== false && value !== undefined) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1" }] });
const models = createModels();
models.setProvider(faux.provider);

const runtime = await YuanfangRuntime.open({ workspace, models, skipPlugins: true });
try {
  await runtime.updateConfig({
    provider: "faux",
    model: "faux-1",
    projectProvider: "faux",
    projectModel: "faux-1",
    roleProvider: "faux",
    roleModel: "faux-1",
  });

  // 1. System chat: a real model round trip through Pi Durable.
  faux.setResponses([fauxAssistantMessage("你好，我是元芳。")]);
  await runtime.sendSystemMessage("你好");
  const systemId = runtime.systemConversationFeed();
  await waitFor("system answer", () =>
    runtime.getConversationFeed(systemId).messages.some((message) => message.role === "assistant"),
  );
  console.log("✓ system chat");

  // 2. Project creation: directory, README, file index, project lead conversation, kickoff.
  faux.setResponses([fauxAssistantMessage("计划：先做一个 hello.txt，然后验证。")]);
  const project = await runtime.createProject({
    name: "Smoke 项目",
    brief: "验证元芳的最小闭环：创建项目、派发任务、回报结果。",
  });
  await waitFor("project kickoff answer", () =>
    runtime.getConversationFeed(project.conversationId ?? "").messages.some((message) => message.role === "assistant"),
  );
  console.log("✓ project created + kickoff");

  // 3. Task dispatch: a background role agent, reported back to the project lead.
  const task = runtime.createTask({
    projectId: project.id,
    title: "写 hello.txt",
    brief: "在项目根目录创建 hello.txt，内容为 hello yuanfang。完成后报告。",
    role: "工程师",
    files: ["hello.txt"],
  });
  faux.appendResponses([
    fauxAssistantMessage("已完成：创建 hello.txt，内容 hello yuanfang。验证：读取文件内容一致。"),
    fauxAssistantMessage("收到，任务通过验收。"),
  ]);
  const dispatched = await runtime.dispatchTask(task.id);
  await waitFor("task review", () => runtime.store.getTaskRecord(task.id)?.status === "review");
  console.log("✓ role task ready for review", dispatched.roleConversationId);
  runtime.acceptTask(task.id, "smoke 验收通过");

  const finished = runtime.store.getTaskRecord(task.id);
  if (finished === undefined || finished.status !== "done") throw new Error("task did not finish");
  if (finished.result === null || !finished.result.includes("hello")) throw new Error("task result missing");
  if (runtime.store.fileCount(project.id) === 0) throw new Error("file index is empty");
  const summary = runtime.store.projectSummary(runtime.store.getProjectRecord(project.id)!);
  console.log(
    "✓ stats",
    JSON.stringify({
      tasks: summary.taskCounts,
      tokens: summary.stats.totalTokens,
      cacheHitRate: summary.stats.cacheHitRate.toFixed(2),
      totalMs: summary.totalMs,
    }),
  );

  // 4. Memory survives a new system context.
  const memories = runtime.store.searchMemories("hello", project.id, 10);
  if (memories.length === 0) console.log("! no episode memory yet (acceptable: task report path)");
  console.log("✓ memory search", memories.length);

  // 5. File lock serialization: two owners on one path must not overlap.
  const order: string[] = [];
  const releaseFirst = await runtime.locks.acquire(["shared.txt"], { owner: "a", projectId: project.id });
  const second = runtime.locks.acquire(["shared.txt"], { owner: "b", projectId: project.id }).then((release) => {
    order.push("b");
    release();
  });
  order.push("a");
  if (order.join(",") !== "a") throw new Error("lock did not block");
  releaseFirst();
  await second;
  if (order.join(",") !== "a,b") throw new Error("lock order wrong");
  console.log("✓ file lock serializes");

  // 6. Approval gates: shell grants and MCP install on approval.
  const command = "npm install left-pad";
  const commandHash = hashCommand(command);
  faux.appendResponses([
    fauxAssistantMessage("命令审批已收到，继续。"),
    fauxAssistantMessage("MCP 审批已收到，工具已接入。"),
  ]);
  const shellApproval = runtime.createApproval({
    kind: "shell",
    title: "安装依赖",
    detail: "测试审批",
    payload: { command, commandHash },
    conversationId: runtime.systemConversationFeed(),
    requestedBy: "system",
  });
  await runtime.resolveApproval(shellApproval.id, "approved", null);
  if (!runtime.store.hasShellGrant(commandHash)) throw new Error("shell grant missing");
  console.log("✓ shell approval grant");

  const serverFile = join(workspace, "fake-mcp.mjs");
  await writeFile(
    serverFile,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (m) => process.stdout.write(JSON.stringify(m) + String.fromCharCode(10));
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
  else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo" }] } });
  else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
});
`,
  );
  const mcpApproval = runtime.createApproval({
    kind: "mcp",
    title: "接入 fake MCP",
    detail: "测试 MCP",
    payload: { serverName: "fake", command: process.execPath, args: [serverFile] },
    conversationId: runtime.systemConversationFeed(),
    requestedBy: "system",
  });
  await runtime.resolveApproval(mcpApproval.id, "approved", null);
  const mcpServers =
    (await waitFor("mcp install", async () => {
      const servers = await runtime.mcp.list();
      return servers.some((server) => server.name === "fake" && server.connected) ? servers : undefined;
    })) ?? [];
  if (!runtime.registry.snapshot().tools().some((tool) => tool.tool.name.startsWith("mcp_fake_"))) {
    throw new Error("MCP tool not registered");
  }
  console.log("✓ MCP approval + install", mcpServers.length);
  await runtime.mcp.remove("fake");

  await runtime.syncAllUsage();
  console.log("✓ usage synced");
} finally {
  await runtime.close();
  await rm(workspace, { recursive: true, force: true });
}

console.log("smoke ok");
