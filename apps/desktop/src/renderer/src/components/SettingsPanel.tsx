import { useEffect, useMemo, useState } from "react";
import type { AppInfoView, RuntimeConfigView, ThemeMode, UpdateConfigInput } from "@yuanfang/shared";
import { CredentialsSection } from "./CredentialsSection";
import { validAccent } from "../lib/appearance";
import { formatHotkey } from "../lib/hotkey";
import { RolesSection } from "./RolesSection";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

type Tab = "appearance" | "identity" | "models" | "credentials" | "runtime" | "workspace" | "updates" | "plugins" | "mcp";

const TABS: Array<{ id: Tab; label: string; hint: string; glyph: string }> = [
  { id: "appearance", label: "外观", hint: "主题与界面字号", glyph: "◐" },
  { id: "identity", label: "身份", hint: "名称与人格", glyph: "人" },
  { id: "models", label: "模型", hint: "默认模型与角色", glyph: "◇" },
  { id: "credentials", label: "凭据", hint: "厂商 API Key / 登录", glyph: "⚿" },
  { id: "runtime", label: "运行", hint: "并发、通知、快捷键", glyph: "▣" },
  { id: "workspace", label: "工作区", hint: "项目目录", glyph: "↻" },
  { id: "updates", label: "更新", hint: "版本与更新源", glyph: "↥" },
  { id: "plugins", label: "插件", hint: "沙箱扩展", glyph: "⊞" },
  { id: "mcp", label: "MCP", hint: "外部工具服务", glyph: "⇄" },
];

const THEMES: Array<{ id: ThemeMode; name: string; description: string }> = [
  { id: "dark", name: "深色", description: "默认的深蓝夜色" },
  { id: "light", name: "浅色", description: "清爽的纸张阅读感" },
  { id: "system", name: "跟随系统", description: "随 macOS / Windows 切换" },
];

const ACCENTS = [
  { name: "靛蓝", color: "#7c8cff" },
  { name: "青绿", color: "#4fc3a1" },
  { name: "琥珀", color: "#f2a65a" },
  { name: "玫瑰", color: "#e06c9f" },
  { name: "天青", color: "#5ab0f0" },
  { name: "紫罗兰", color: "#b48cff" },
];

const UI_SCALES = [
  { value: 0.9, label: "小", hint: "90%" },
  { value: 1, label: "标准", hint: "100%" },
  { value: 1.1, label: "大", hint: "110%" },
  { value: 1.2, label: "特大", hint: "120%" },
];

export function SettingsPanel({
  config,
  onSave,
  onOpenWorkspace,
  onClose,
}: {
  config: RuntimeConfigView;
  onSave: (input: UpdateConfigInput) => Promise<void>;
  onOpenWorkspace: () => Promise<void>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("appearance");
  const [draft, setDraft] = useState(config);
  const [persona, setPersona] = useState(config.persona);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plugins, setPlugins] = useState<Array<{ name: string; description: string; loaded: boolean; error: string | null; path: string; permissions: string[]; sandboxed: boolean }>>([]);
  const [mcpServers, setMcpServers] = useState<Array<{ name: string; command: string; args: string[]; url: string | null; oauth: boolean; projects: string[]; connected: boolean; tools: Array<{ name: string; description: string }>; error: string | null }>>([]);
  const [modelQuery, setModelQuery] = useState("");
  const [appInfo, setAppInfo] = useState<AppInfoView | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setDraft(config);
    setPersona(config.persona);
  }, [config]);

  useEffect(() => {
    void window.yuanfang.getPlugins().then(setPlugins);
    void window.yuanfang.getMcpServers().then(setMcpServers);
    void window.yuanfang.getAppInfo().then(setAppInfo).catch(() => undefined);
  }, []);

  const providers = useMemo(() => {
    const needle = modelQuery.trim().toLowerCase();
    const map = new Map<string, Array<{ modelId: string; name: string; contextWindow: number }>>();
    for (const model of config.availableModels) {
      if (
        needle.length > 0 &&
        !model.name.toLowerCase().includes(needle) &&
        !model.modelId.toLowerCase().includes(needle) &&
        !model.provider.toLowerCase().includes(needle)
      ) {
        continue;
      }
      const list = map.get(model.provider) ?? [];
      list.push({ modelId: model.modelId, name: model.name, contextWindow: model.contextWindow });
      map.set(model.provider, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [config.availableModels, modelQuery]);

  const save = async () => {
    if (!validAccent(draft.accent)) {
      setError("主题色必须是 #RRGGBB 格式。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        agentName: draft.agentName,
        provider: draft.provider,
        model: draft.model,
        projectProvider: draft.projectProvider,
        projectModel: draft.projectModel,
        roleProvider: draft.roleProvider,
        roleModel: draft.roleModel,
        thinkingLevel: draft.thinkingLevel,
        roleThinkingLevel: draft.roleThinkingLevel,
        maxTurns: draft.maxTurns,
        maxConcurrentTasks: draft.maxConcurrentTasks,
        notifyLevel: draft.notifyLevel,
        worktreePerTask: draft.worktreePerTask,
        dailyTokenBudget: draft.dailyTokenBudget,
        updateFeedUrl: draft.updateFeedUrl,
        quickAskHotkey: draft.quickAskHotkey,
        accent: draft.accent,
        defaultProjectName: draft.defaultProjectName,
        defaultProjectPath: draft.defaultProjectPath,
        modelTimeoutMinutes: draft.modelTimeoutMinutes,
        bashTimeoutMinutes: draft.bashTimeoutMinutes,
        staleGenerationMinutes: draft.staleGenerationMinutes,
        staleToolMinutes: draft.staleToolMinutes,
        theme: draft.theme,
        uiScale: draft.uiScale,
        persona,
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const checkUpdates = async () => {
    setChecking(true);
    setError(null);
    try {
      await window.yuanfang.checkForUpdates();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      window.setTimeout(() => setChecking(false), 800);
    }
  };

  const modelSelect = (
    label: string,
    provider: string,
    model: string,
    onChange: (provider: string, model: string) => void,
  ) => (
    <label>
      {label}
      <select
        value={`${provider}/${model}`}
        onChange={(event) => {
          const [nextProvider, ...rest] = event.target.value.split("/");
          onChange(nextProvider ?? "", rest.join("/"));
        }}
      >
        {providers.map(([providerId, models]) => (
          <optgroup key={providerId} label={providerId}>
            {models.map((entry) => (
              <option key={`${providerId}/${entry.modelId}`} value={`${providerId}/${entry.modelId}`}>
                {entry.name}（{entry.modelId}）
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );

  const currentTab = TABS.find((item) => item.id === tab) ?? TABS[0]!;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header settings-header">
          <div>
            <h2>设置</h2>
            <p>{currentTab.hint}。改动会在下次请求或下次启动时生效。</p>
          </div>
          <div className="modal-header-actions">
            <button className="icon-button" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置栏目">
            {TABS.map((item) => (
              <button
                key={item.id}
                className={`settings-nav-item ${tab === item.id ? "active" : ""}`}
                onClick={() => setTab(item.id)}
              >
                <span className="settings-nav-glyph">{item.glyph}</span>
                <span>
                  <strong>{item.label}</strong>
                  <em>{item.hint}</em>
                </span>
              </button>
            ))}
            <div className="settings-nav-footer">
              <button className="ghost-button small" onClick={() => void checkUpdates()} disabled={checking}>
                {checking ? "检查中…" : "检查更新"}
              </button>
              <span>v{appInfo?.version ?? "…"}</span>
            </div>
          </nav>

          <div className="settings-content">
            {tab === "appearance" ? (
              <section className="settings-section">
                <h3>主题</h3>
                <p className="muted small">选择元芳的界面色调。跟随系统会在系统切换明暗时自动变化。</p>
                <div className="theme-options">
                  {THEMES.map((theme) => (
                    <button
                      key={theme.id}
                      className={`theme-option ${draft.theme === theme.id ? "active" : ""}`}
                      onClick={() => setDraft({ ...draft, theme: theme.id })}
                    >
                      <span className={`theme-preview theme-${theme.id}`}>
                        <i />
                        <b />
                        <em />
                      </span>
                      <span className="theme-copy">
                        <strong>{theme.name}</strong>
                        <small>{theme.description}</small>
                      </span>
                      {draft.theme === theme.id ? <span className="theme-check">✓</span> : null}
                    </button>
                  ))}
                </div>

                <h3 className="settings-subhead">界面字号</h3>
                <p className="muted small">会同时缩放文字和控件，保存后生效；下次打开应用时保持。</p>
                <div className="scale-options">
                  {UI_SCALES.map((item) => (
                    <button
                      key={item.value}
                      className={`scale-option ${Math.abs(draft.uiScale - item.value) < 0.001 ? "active" : ""}`}
                      onClick={() => setDraft({ ...draft, uiScale: item.value })}
                    >
                      <strong>{item.label}</strong>
                      <span>{item.hint}</span>
                    </button>
                  ))}
                </div>
                <div className="appearance-note">
                  <span className="logo-mark small" />
                  当前选择：{THEMES.find((theme) => theme.id === draft.theme)?.name} ·{" "}
                  {UI_SCALES.find((item) => Math.abs(item.value - draft.uiScale) < 0.001)?.label ?? "标准"}
                </div>

                <h3 className="settings-subhead">主题色</h3>
                <p className="muted small">主题色用于按钮、选中状态、强调文字和焦点边框。可以选预设，也可以自定义。</p>
                <div className="accent-options">
                  {ACCENTS.map((accent) => (
                    <button
                      key={accent.color}
                      className={`accent-option ${draft.accent.toLowerCase() === accent.color ? "active" : ""}`}
                      onClick={() => setDraft({ ...draft, accent: accent.color })}
                      title={accent.name}
                    >
                      <span className="accent-swatch" style={{ background: accent.color }} />
                      <span>{accent.name}</span>
                    </button>
                  ))}
                  <label className="accent-custom">
                    <input
                      type="color"
                      value={draft.accent}
                      onChange={(event) => setDraft({ ...draft, accent: event.target.value })}
                    />
                    <span>自定义</span>
                  </label>
                </div>
                <div className="accent-hex-row">
                  <span>当前色值</span>
                  <input
                    value={draft.accent}
                    onChange={(event) => setDraft({ ...draft, accent: event.target.value })}
                    maxLength={7}
                    spellCheck={false}
                  />
                  <span className="accent-preview" style={{ background: draft.accent }} />
                </div>
              </section>
            ) : null}

            {tab === "identity" ? (
              <>
                <section className="settings-section">
                  <h3>系统 Agent</h3>
                  <div className="form-row">
                    <label>
                      名称
                      <input
                        value={draft.agentName}
                        onChange={(event) => setDraft({ ...draft, agentName: event.target.value })}
                        placeholder="元芳"
                      />
                    </label>
                  </div>
                  <p className="muted small">默认「元芳」。名称用于对话、通知、人格提示和托盘提示。</p>
                </section>
                <section className="settings-section">
                  <h3>人格</h3>
                  <p className="muted small">系统 Agent 的人格写在这里。每次请求都会重新读取。</p>
                  <textarea className="persona-editor" value={persona} rows={16} onChange={(event) => setPersona(event.target.value)} />
                  <div className="muted small">{config.personaPath}</div>
                </section>
              </>
            ) : null}

            {tab === "models" ? (
              <>
                <section className="settings-section">
                  <h3>默认模型</h3>
                  <input
                    className="model-search"
                    value={modelQuery}
                    onChange={(event) => setModelQuery(event.target.value)}
                    placeholder="搜索模型、provider 或 model id…"
                  />
                  <div className="form-row">
                    {modelSelect("系统 Agent", draft.provider, draft.model, (provider, model) => setDraft({ ...draft, provider, model }))}
                    {modelSelect("项目负责人", draft.projectProvider, draft.projectModel, (provider, model) =>
                      setDraft({ ...draft, projectProvider: provider, projectModel: model }),
                    )}
                    {modelSelect("角色 Agent", draft.roleProvider, draft.roleModel, (provider, model) =>
                      setDraft({ ...draft, roleProvider: provider, roleModel: model }),
                    )}
                  </div>
                  <div className="form-row">
                    <label>
                      系统思考等级
                      <select value={draft.thinkingLevel} onChange={(event) => setDraft({ ...draft, thinkingLevel: event.target.value })}>
                        {THINKING_LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      角色思考等级
                      <select value={draft.roleThinkingLevel} onChange={(event) => setDraft({ ...draft, roleThinkingLevel: event.target.value })}>
                        {THINKING_LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      单轮最大工具轮次
                      <input
                        type="number"
                        min={1}
                        value={draft.maxTurns}
                        onChange={(event) => setDraft({ ...draft, maxTurns: Number(event.target.value) })}
                      />
                    </label>
                    <label>
                      每项目最大并发任务
                      <input
                        type="number"
                        min={1}
                        max={32}
                        value={draft.maxConcurrentTasks}
                        onChange={(event) => setDraft({ ...draft, maxConcurrentTasks: Number(event.target.value) })}
                      />
                    </label>
                  </div>
                </section>
                <RolesSection availableModels={config.availableModels} />
              </>
            ) : null}

            {tab === "credentials" ? (
              <CredentialsSection
                onPickModel={(target, provider, modelId) => {
                  if (target === "system") setDraft({ ...draft, provider, model: modelId });
                  else if (target === "project") setDraft({ ...draft, projectProvider: provider, projectModel: modelId });
                  else setDraft({ ...draft, roleProvider: provider, roleModel: modelId });
                }}
              />
            ) : null}

            {tab === "runtime" ? (
              <>
                <section className="settings-section">
                  <h3>通知与预算</h3>
                  <div className="form-row">
                    <label>
                      通知级别
                      <select value={draft.notifyLevel} onChange={(event) => setDraft({ ...draft, notifyLevel: event.target.value as typeof draft.notifyLevel })}>
                        <option value="all">全部</option>
                        <option value="important">只弹重要（审批 / 失败）</option>
                        <option value="off">关闭</option>
                      </select>
                    </label>
                    <label>
                      每日 token 预算（0 = 不限）
                      <input
                        type="number"
                        min={0}
                        value={draft.dailyTokenBudget}
                        onChange={(event) => setDraft({ ...draft, dailyTokenBudget: Number(event.target.value) })}
                      />
                    </label>
                  </div>
                </section>
                <section className="settings-section">
                  <h3>快速提问</h3>
                  <label>
                    全局快捷键
                    <input
                      value={draft.quickAskHotkey}
                      onChange={(event) => setDraft({ ...draft, quickAskHotkey: event.target.value })}
                      placeholder="CommandOrControl+Shift+Space"
                    />
                  </label>
                  <p className="muted small">
                    使用 Electron 快捷键格式，例如 <code>CommandOrControl+Shift+Space</code>；保存后立即注册，重启后保留。
                    当前显示为 <strong>{formatHotkey(draft.quickAskHotkey)}</strong>。
                  </p>
                </section>
                <section className="settings-section">
                  <h3>超时与恢复</h3>
                  <div className="form-row">
                    <label>
                      模型请求超时（分钟）
                      <input type="number" min={1} max={60} value={draft.modelTimeoutMinutes} onChange={(event) => setDraft({ ...draft, modelTimeoutMinutes: Number(event.target.value) })} />
                    </label>
                    <label>
                      Shell 单条命令超时（分钟）
                      <input type="number" min={5} max={180} value={draft.bashTimeoutMinutes} onChange={(event) => setDraft({ ...draft, bashTimeoutMinutes: Number(event.target.value) })} />
                    </label>
                    <label>
                      启动恢复：模型阈值（分钟）
                      <input type="number" min={5} max={240} value={draft.staleGenerationMinutes} onChange={(event) => setDraft({ ...draft, staleGenerationMinutes: Number(event.target.value) })} />
                    </label>
                    <label>
                      启动恢复：Shell 阈值（分钟）
                      <input type="number" min={10} max={480} value={draft.staleToolMinutes} onChange={(event) => setDraft({ ...draft, staleToolMinutes: Number(event.target.value) })} />
                    </label>
                  </div>
                  <p className="muted small">
                    超时只作用于单次模型请求 / 单条 shell 命令，不是任务总时长。默认模型 5 分钟、Shell 30 分钟；启动恢复只处理上次强制退出或重启时超过阈值的旧 pending 请求。
                  </p>
                </section>
                <section className="settings-section">
                  <h3>任务隔离</h3>
                  <label className="inline-check">
                    <input
                      type="checkbox"
                      checked={draft.worktreePerTask}
                      onChange={(event) => setDraft({ ...draft, worktreePerTask: event.target.checked })}
                    />
                    每个任务使用独立 git worktree（要求项目是干净的 git 仓库）
                  </label>
                  <p className="muted small">
                    开启后角色在独立分支工作；验收通过时自动合并回主工作树，退回/取消时丢弃。git 不干净或没有提交时自动回退到主工作区。
                  </p>
                </section>
              </>
            ) : null}

            {tab === "workspace" ? (
              <>
                <section className="settings-section">
                  <h3>默认项目</h3>
                  <p className="muted small">用来放零散文件和日常办公内容；它始终排在项目列表最前，不会因为长期不活跃被淹没。</p>
                  <label>
                    名称
                    <input
                      value={draft.defaultProjectName}
                      onChange={(event) => setDraft({ ...draft, defaultProjectName: event.target.value })}
                      placeholder="日常"
                    />
                  </label>
                  <label>
                    位置
                    <div className="path-row">
                      <input
                        value={draft.defaultProjectPath}
                        onChange={(event) => setDraft({ ...draft, defaultProjectPath: event.target.value })}
                        placeholder="~/Documents/元芳日常"
                      />
                      <button
                        className="ghost-button small"
                        onClick={() => {
                          void window.yuanfang.chooseFolder(draft.defaultProjectPath).then((selected) => {
                            if (selected !== null) setDraft({ ...draft, defaultProjectPath: selected });
                          });
                        }}
                      >
                        选择文件夹…
                      </button>
                    </div>
                  </label>
                  <p className="muted small">改动名称或位置后保存；位置变更会重新索引新目录，不会自动搬走旧目录里的文件。</p>
                </section>
                <section className="settings-section">
                  <h3>工作区</h3>
                  <div className="workspace-row">
                    <code>{config.workspace}</code>
                    <button className="ghost-button" onClick={() => void onOpenWorkspace()}>
                      打开目录
                    </button>
                  </div>
                  <div className="muted small">普通项目默认创建在 {config.defaultProjectDir}</div>
                </section>
              </>
            ) : null}

            {tab === "updates" ? (
              <>
                <section className="settings-section">
                  <h3>版本</h3>
                  <div className="update-card">
                    <div>
                      <strong>元芳 {appInfo?.version ?? "…"}</strong>
                      <span>
                        {appInfo === null
                          ? "正在读取版本…"
                          : appInfo.packaged
                            ? "已安装版本"
                            : "开发模式（不检查更新）"}
                      </span>
                    </div>
                    <button className="primary-button compact" onClick={() => void checkUpdates()} disabled={checking}>
                      {checking ? "检查中…" : "检查更新"}
                    </button>
                  </div>
                  <p className="muted small">启动后会自动检查一次；发现新版本会先询问，同意后才下载并重启安装。</p>
                </section>
                <section className="settings-section">
                  <h3>更新源</h3>
                  <label>
                    下载地址目录
                    <input
                      value={draft.updateFeedUrl}
                      onChange={(event) => setDraft({ ...draft, updateFeedUrl: event.target.value })}
                      placeholder="https://github.com/…/releases/latest/download"
                    />
                  </label>
                  <p className="muted small">元芳会按平台自动读取 latest-mac.yml / latest.yml / latest-linux.yml。修改后保存，下一次检查生效。</p>
                </section>
              </>
            ) : null}

            {tab === "plugins" ? (
              <section className="settings-section">
                  <h3>插件</h3>
                  {plugins.length === 0 ? <div className="muted">还没有插件。系统 Agent 可以通过 plugin_write 创建。</div> : null}
                  <div className="plugin-list">
                    {plugins.map((plugin) => (
                      <div key={plugin.name} className="plugin-row">
                        <div>
                          <strong>{plugin.name}</strong>
                          <p>{plugin.description || "（无描述）"}</p>
                          <p className="muted small">权限：{plugin.permissions.length > 0 ? plugin.permissions.join(", ") : "无"} · {plugin.sandboxed ? "沙箱" : "进程内"}</p>
                          {plugin.error !== null ? <span className="task-error">{plugin.error}</span> : null}
                        </div>
                        <div className="plugin-actions">
                          <span className={`chip ${plugin.loaded ? "done" : "failed"}`}>{plugin.loaded ? "已加载" : "未加载"}</span>
                          <button
                            className="small-button danger"
                            onClick={() => {
                              if (!window.confirm(`删除插件「${plugin.name}」？`)) return;
                              void window.yuanfang.removePlugin(plugin.name).then(() => window.yuanfang.getPlugins().then(setPlugins));
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button className="ghost-button" onClick={() => void window.yuanfang.reloadPlugins().then(() => window.yuanfang.getPlugins().then(setPlugins))}>
                    重新加载插件
                  </button>
              </section>
            ) : null}

            {tab === "mcp" ? (
              <section className="settings-section">
                  <h3>MCP 服务器</h3>
                  {mcpServers.length === 0 ? <div className="muted">还没有 MCP。让系统 Agent 通过 mcp_add 申请接入。</div> : null}
                  <div className="plugin-list">
                    {mcpServers.map((server) => (
                      <div key={server.name} className="plugin-row">
                        <div>
                          <strong>{server.name}</strong>
                          <p>{server.url ?? `${server.command} ${server.args.join(" ")}`}{server.oauth ? " · OAuth" : ""}</p>
                          {server.projects.length > 0 ? <p className="muted small">项目：{server.projects.join(", ")}</p> : null}
                          <p className="muted small">{server.tools.map((tool) => tool.name).join(", ") || "无工具"}</p>
                          {server.error !== null ? <span className="task-error">{server.error}</span> : null}
                        </div>
                        <div className="plugin-actions">
                          <span className={`chip ${server.connected ? "done" : "failed"}`}>{server.connected ? "已连接" : "未连接"}</span>
                          <button
                            className="small-button danger"
                            onClick={() => void window.yuanfang.removeMcpServer(server.name).then(() => window.yuanfang.getMcpServers().then(setMcpServers))}
                          >
                            移除
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
              </section>
            ) : null}
          </div>
        </div>

        {error === null ? null : <div className="form-error settings-error">{error}</div>}
        <footer className="modal-footer">
          <button className="ghost-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" disabled={saving} onClick={() => void save()}>
            {saving ? "保存中…" : "保存设置"}
          </button>
        </footer>
      </div>
    </div>
  );
}
