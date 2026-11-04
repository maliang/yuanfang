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
- **技能与插件**：Agent 可自建/修改 `SKILL.md`，可写 `.mjs` 插件；插件审批后在 QuickJS 沙箱加载。
- **联网**：`web_search` / `web_fetch` 查文档、找工具、看包页面。
- **MCP / 插件 / 技能管理**：MCP 审批后接入（stdio 或 Streamable HTTP），可按项目授权；设置页可查看/移除 MCP、删除插件；技能可编辑/删除；记忆可编辑/删除/置顶。
- **厂商凭据设置**：设置页左侧厂商、右侧配置；填入 API Key 后保存并动态拉取该厂商模型；OAuth-only 厂商也在同一详情里直接登录；显示凭据来源（远方 / Pi / 环境变量），不会误删 Pi 的登录。
- **通知中心**：审批、失败、待验收、项目汇报和系统回复都有记录；支持未读徽标、全部已读和跳转。
- **自动更新**：设置更新源后，打包版本启动会检查新版本；提示并同意后下载，完成后自动重启安装。
- **人格与名字**：`~/.yuanfang/persona.md` 可编辑；系统 Agent 默认叫「元芳」，名字可在设置里改。
- **桌面体验**：项目卡片（Agent 用时 / 计费 tokens / 缓存命中 / 创建与更新时间）、可折叠右侧对话栏、停止按钮、未读徽标、全局快捷键、任务栏通知、托盘菜单、审批面板、任务工具时间线与 diff。
- **可控性**：项目暂停/归档会阻止新任务和新指令；每个项目限制最大并发；通知可设为全部 / 仅重要 / 关闭。
- **角色与流程**：内置产品经理 / UI 设计师 / 架构师 / 前端 / 后端 / 全栈 / 测试 / 代码审查 / 安全审计 / DevOps / 文档 / 执行等角色；设置页可编辑 instructions、为每个角色指定不同模型；项目可定义 workflow 阶段，任务带 stage，`advance_task` 推进下一阶段，验收门强制在最后阶段。
- **git worktree 隔离**：设置里可开启每个任务独立 worktree；验收通过自动合并回主工作树，退回/取消丢弃。要求项目是干净的 git 仓库；否则自动回退主工作区 + 文件占用。
- **每日 token 预算**：超过预算后新任务会被拒绝；可在设置里设置 0 关闭。
- **插件沙箱**：`plugin_write` 先保存代码并发起审批，批准后在 QuickJS WASM 子进程中加载；插件没有 process / require / fs / net，只能通过声明的 `projects:read` / `projects:write` 能力访问项目文件。
- **角色模型**：每个角色可单独指定 provider/model；设置页可编辑 instructions。

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

元芳**内嵌 Pi Durable 和 pi-ai 模型目录**，不需要用户另外安装 Pi。

- 凭据默认写入 `~/.yuanfang/auth.json`，可以在设置页直接配置 API Key 或 OAuth。
- 如果本机恰好有 Pi，会读取 `~/.pi/agent/auth.json` 作为可选来源（只读，不会修改），也可以在设置页一键导入到远方。
- 默认 provider/model 优先读取远方配置；首次没有配置时，如果本机有 `~/.pi/agent/settings.json` 会借鉴其默认值，否则使用内置示例。
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
  src/plugins.ts        # .mjs 插件审批与 QuickJS 沙箱
  src/smoke.ts          # 端到端 smoke（faux provider）
apps/desktop/
  src/main/             # Electron 主进程：窗口、托盘、快捷键、通知、IPC
  src/preload/          # contextBridge
  src/renderer/         # React UI
```

更细的设计与需求映射见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
需要你亲手确认的项见 [docs/MANUAL-VERIFY.md](docs/MANUAL-VERIFY.md)。

## 发布与升级

推送 `v*` tag 会触发 GitHub Actions：

```bash
# 先把 apps/desktop/package.json 的 version 改成 0.2.1
git tag v0.2.1
git push origin v0.2.1
```

工作流会在 macOS 上：

1. 校验 tag 与 `apps/desktop/package.json` 版本一致；
2. `npm ci`；
3. `typecheck` + `smoke`；
4. `electron-builder --mac --arm64 --publish always`；
5. 上传 `.dmg` / `.zip` / `latest-mac.yml` 到 GitHub Release。

设置里的默认更新源是：

`https://github.com/maliang/yuanfang/releases/latest/download`

所以发布后，已安装的打包版本会检查该地址的 `latest-mac.yml`，提示并自动升级。当前产物是 unsigned；正式分发需要签名/公证。

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

- MCP 支持 stdio、Streamable HTTP 和 MCP OAuth；OAuth 回调/浏览器流程需要真机验证。
- 记忆是 SQLite + 关键词/全文检索，不是向量检索；适合单机、单用户规模。
- 插件在 QuickJS WASM 沙箱内运行，没有 Node 全局；但宿主能力仍受审批时的 permissions 控制，恶意代码请勿批准。
- 已提供 unsigned 打包：`npm run dist`（dmg）或 `npm run dist:dir`（.app）；更新源配置后可提示并自动下载/重启安装，但没有代码签名。
- 通知的 app 名称和图标需要打包后才完全正确；开发模式下可能显示 Electron。
- 系统 Agent 的一次用户回合结束后会 `reset` 成新上下文（用记忆 handoff），因此模型不再看到完整原始对话；UI 仍然保留完整消息。
- 文件占用只覆盖任务声明过的 `files`；worktree 模式可以绕开，但要求干净的 git 仓库。
- worktree 自动合并遇到冲突会停下并保留分支，需要手动解决；没有自动冲突合并。
- 通知中心已支持系统消息锚点；项目/角色消息会打开任务详情，但不会逐条高亮。
- i18n 还没做，目前只有中文。

## Roadmap

- MCP 更细的工具权限与 OAuth 真机验证。
- 代码签名、公证与正式更新服务。
- worktree 冲突的自动合并与一键回滚。
- 向量 + 关键词混合记忆，记忆过期与遗忘策略。
- 更细的插件网络隔离（当前 QuickJS 已隔离 Node，但没有 OS 级网络/资源配额）。
- i18n。
- 多用户 / 远程运行时（Pi Durable 的 storage 与 env 已经为此留了口子）。
