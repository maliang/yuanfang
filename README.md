# 元芳 · Yuanfang

> 一个把「判断需求 → 立项 → 拆解 → 并行执行 → 验收 → 记忆」串起来的持久化 Agent 系统。
> 用户只需要和系统 Agent 说话。

元芳构建在 [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 上：每个 Agent 是一个可恢复的 conversation，每个任务是一个带检查点的 durable task。进程崩溃、电脑休眠、应用重启之后，未完成的工作会从最后一个检查点继续。

## 现在能做什么

- **一个主 Agent**：判断闲聊 / 单点问题 / 需要立项，负责创建项目和与项目负责人沟通。
- **每个项目一个负责人**：拆任务、派发、并行、验收、向上汇报。角色完成后进入「待验收」，只有负责人或你明确通过才算 done。
- **角色 Agent 执行任务**：每个任务一个独立 conversation，独立模型、独立上下文、独立计费。
- **同文件串行**：任务声明 `files` 后，整个任务会先占住这些文件；其他任务在角色启动前等待。`edit`/`write` 还有一层可重入锁。
- **后台执行**：任务在 durable background task 中运行，不阻塞你与系统 Agent、系统 Agent 与项目负责人的对话。角色中途请求审批时，任务会停在「等待审批」，审批后同一个任务继续，不会假完成。
- **系统 Agent 有记忆**：偏好、决策、架构、踩坑和对话片段会进入长期记忆；每次对话用记忆重建上下文，界面保持连贯。
- **项目索引**：扫描项目目录，建立路径 / 语言 / 摘要索引，`repo_find` / `search_everything` 快速定位。
- **技能与插件**：Agent 可自建/修改 `SKILL.md`，可写 `.mjs` 插件并热加载。
- **联网**：`web_search` / `web_fetch` 查文档、找工具、看包页面。
- **MCP / 插件 / 技能管理**：MCP 审批后接入（stdio 或 Streamable HTTP），可按项目授权；设置页可查看/移除 MCP、删除插件；技能可编辑/删除；记忆可编辑/删除/置顶。
- **厂商凭据设置**：设置页左侧厂商、右侧配置；填入 API Key 后保存并动态拉取该厂商模型；显示凭据来源（远方 / Pi / 环境变量），不会误删 Pi 的登录。
- **通知中心**：审批、失败、待验收、项目汇报和系统回复都有记录；支持未读徽标、全部已读和跳转。
- **人格与名字**：`~/.yuanfang/persona.md` 可编辑；系统 Agent 默认叫「元芳」，名字可在设置里改。
- **桌面体验**：项目卡片（Agent 用时 / 计费 tokens / 缓存命中 / 创建与更新时间）、可折叠右侧对话栏、停止按钮、未读徽标、全局快捷键、任务栏通知、托盘菜单、审批面板、任务工具时间线与 diff。
- **可控性**：项目暂停/归档会阻止新任务和新指令；每个项目限制最大并发；通知可设为全部 / 仅重要 / 关闭。
- **角色定义**：内置架构师/前端/后端/测试/文档/执行，可由 Agent 通过 `role_upsert` 扩展，角色说明会注入角色 Agent。

## 快速开始

要求：macOS（当前主要验证平台）、Node.js ≥ 22.19、npm。

```bash
npm install
npm run dev          # 开发模式（Vite + Electron）
# 或者：
npm run app          # 构建后直接启动
```

如果 Electron 下载失败（国内网络常见）：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

启动后：

- 主窗口：项目卡片 + 右侧「元芳」对话栏。
- `⌘⇧Space`：呼出快速提问框；回复会从任务栏弹出，点击回到对话。
- 托盘图标：打开主窗口 / 快速提问 / 打开工作区 / 退出。
- 应用菜单「元芳」：打开主窗口、审批、记忆。

### 模型与凭据

元芳默认复用 Pi 已经登录的凭据：

- 读取 `~/.pi/agent/auth.json`（只读，不会修改 Pi 的凭据）。
- OAuth 刷新/新登录写入 `~/.yuanfang/auth.json`。
- 默认 provider/model 读取 `~/.pi/agent/settings.json` 的 `defaultProvider` / `defaultModel`。
- 首次启动写入 `~/.yuanfang/config.json`，之后可在「设置」里分别配置系统 / 项目负责人 / 角色 Agent 的模型。

设置页的「厂商与凭据」是左侧厂商、右侧配置：填 API Key → 保存并拉取模型 → 点「系统 / 项目 / 角色」填入模型 → 保存设置。凭据写入 `~/.yuanfang/auth.json`（600）；Pi 的 auth 只读，不会被删除。

### 数据目录

```
~/.yuanfang/
├── config.json          # 模型、思考等级、工作区
├── persona.md           # 系统 Agent 的人格
├── auth.json            # 元芳自己的凭据（可选）
├── mcp.json             # MCP server 配置（600）
├── roles.json           # 角色定义（可被 role_upsert 修改）
├── backups/             # npm run backup 生成的一致快照
├── data/
│   ├── yuanfang.sqlite  # 项目、任务、消息、记忆、索引、审批
│   └── harness.sqlite   # Pi Durable：conversations / tasks / documents
├── projects/            # 默认项目目录
├── skills/              # 全局技能
├── plugins/             # .mjs 插件
└── logs/
```

## 使用方式

1. 在右侧和元芳说一句话。它会判断要不要立项；需要时自动 `create_project`。
2. 项目创建后，负责人立即接手：拆任务、`dispatch_ready` 并行派发。
3. 卡片实时显示Agent 用时、tokens、缓存命中、任务进度。
4. 点进项目：任务板、角色对话、架构索引、项目记忆、项目负责人对话。
5. 需要安装软件、接入 MCP、访问外部账号时，元芳会发起审批。批准后请求方收到结果并继续。
6. 任务完成/失败会从任务栏弹通知；点通知回到对应项目。
7. 想直接干预某个项目：在项目「项目对话」里以系统 Agent 身份留言，或直接对元芳说。

## 代码结构

```
packages/shared/        # 跨进程协议类型 + IPC channel
packages/core/          # 运行时：Pi Durable 编排、工具、记忆、索引、MCP
  src/runtime.ts        # 打开 harness、Agent 生命周期、事件、统计、IPC facade
  src/tools.ts          # system / project / role / shared 工具 + 文件锁 wrapper + 审批 guard
  src/task-defs.ts      # Anchor + RoleRun durable task
  src/prompts.ts        # 人格、运作规则、记忆/项目/任务/技能 section、handoff
  src/store.ts          # SQLite：项目 / 任务 / 消息 / 记忆 / 文件索引 / 审批 / usage
  src/locks.ts          # 跨 Agent 文件锁
  src/memory + indexer  # 记忆摘要 / 项目文件索引
  src/mcp.ts            # stdio / HTTP MCP client + 动态工具注册
  src/plugins.ts        # .mjs 插件热加载
  src/smoke.ts          # 端到端 smoke（faux provider）
apps/desktop/
  src/main/             # Electron 主进程：窗口、托盘、快捷键、通知、IPC
  src/preload/          # contextBridge
  src/renderer/         # React UI
```

更细的设计与需求映射见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
需要你亲手确认的项见 [docs/MANUAL-VERIFY.md](docs/MANUAL-VERIFY.md)。

## 验证

```bash
npm run typecheck      # shared + core + desktop
npm run smoke          # faux provider 的端到端：对话、项目、任务、验收、锁、审批、MCP
npm run backup         # 一致快照到 ~/.yuanfang/backups（含 SQLite / config / persona / MCP / roles）
npm run build          # core + Electron 三段构建
```

静默 UI 验证（不弹窗、不抢焦点）：

```bash
cd apps/desktop
YUANFANG_E2E=1 YUANFANG_E2E_CAPTURE=1 YUANFANG_HOME=/tmp/yuanfang-e2e-home \
  ../../node_modules/.bin/electron .
# 截图与 DOM 断言输出到 /tmp/yuanfang-e2e
```

## 已知边界

- MCP 支持 stdio 和 Streamable HTTP；OAuth 连接尚未接入。
- 记忆是 SQLite + 关键词/全文检索，不是向量检索；适合单机、单用户规模。
- 插件是可信的进程内代码，没有沙箱。只让元芳写你愿意运行的插件。
- 还没有代码签名、自动更新和安装包；当前用 `npm run dev` / `electron .` 运行。
- 通知的 app 名称和图标需要打包后才完全正确；开发模式下可能显示 Electron。
- 系统 Agent 的一次用户回合结束后会 `reset` 成新上下文（用记忆 handoff），因此模型不再看到完整原始对话；UI 仍然保留完整消息。
- 文件占位只覆盖任务声明过的 `files`；未声明文件仍可能被 `bash` 写入。建议项目负责人拆任务时把文件写全。
- 角色 Agent 和项目负责人都运行在同一工作树，没有 per-task worktree / 自动 git 分支；任务时间线能看到 diff，但没有自动合并/回滚。
- OAuth-only 厂商的交互式登录还没有搬到远方 UI；先在 Pi 登录即可复用。
- 通知中心支持跳转，但项目/角色消息的精确定位仍受限于任务详情加载；系统对话消息已支持锚点滚动。

## Roadmap

- MCP Streamable HTTP + OAuth + 按项目选择 server。
- 打包（electron-builder）、签名、自动更新。
- 自动合并 / 一键回滚 / 更完整的验收报告。
- 向量 + 关键词混合记忆，记忆去重与遗忘策略。
- 插件权限清单与沙箱。
- 多用户 / 远程运行时（Pi Durable 的 storage 与 env 已经为此留了口子）。
