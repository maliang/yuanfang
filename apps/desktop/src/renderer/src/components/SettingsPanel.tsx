import { useEffect, useMemo, useState } from "react";
import type { RuntimeConfigView, UpdateConfigInput } from "@yuanfang/shared";
import { CredentialsSection } from "./CredentialsSection";
import { RolesSection } from "./RolesSection";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

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
  const [draft, setDraft] = useState(config);
  const [persona, setPersona] = useState(config.persona);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plugins, setPlugins] = useState<Array<{ name: string; description: string; loaded: boolean; error: string | null; path: string; permissions: string[]; sandboxed: boolean }>>([]);
  const [mcpServers, setMcpServers] = useState<Array<{ name: string; command: string; args: string[]; url: string | null; oauth: boolean; projects: string[]; connected: boolean; tools: Array<{ name: string; description: string }>; error: string | null }>>([]);
  const [modelQuery, setModelQuery] = useState("");

  useEffect(() => {
    setDraft(config);
    setPersona(config.persona);
  }, [config]);

  useEffect(() => {
    void window.yuanfang.getPlugins().then(setPlugins);
    void window.yuanfang.getMcpServers().then(setMcpServers);
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
        persona,
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2>设置</h2>
            <p>模型、人格和工作区。改动会在下一次模型请求时生效。</p>
          </div>
          <div className="modal-header-actions">
            <button className="icon-button" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>

        <div className="settings-sections">
          <section className="settings-section">
            <h3>身份</h3>
            <div className="form-row">
              <label>
                系统 Agent 名称
                <input
                  value={draft.agentName}
                  onChange={(event) => setDraft({ ...draft, agentName: event.target.value })}
                  placeholder="元芳"
                />
              </label>
            </div>
            <p className="muted small">默认「元芳」。名称用于对话、通知、人格提示和托盘提示。</p>
          </section>

          <RolesSection availableModels={config.availableModels} />

          <CredentialsSection
            onPickModel={(target, provider, modelId) => {
              if (target === "system") setDraft({ ...draft, provider, model: modelId });
              else if (target === "project") setDraft({ ...draft, projectProvider: provider, projectModel: modelId });
              else setDraft({ ...draft, roleProvider: provider, roleModel: modelId });
            }}
          />

          <section className="settings-section">
            <h3>模型</h3>
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
            <h3>人格</h3>
            <p className="muted">系统 Agent 的人格写在这里。每次请求都会重新读取。</p>
            <textarea className="persona-editor" value={persona} rows={14} onChange={(event) => setPersona(event.target.value)} />
            <div className="muted small">{config.personaPath}</div>
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

          <section className="settings-section">
            <h3>更新</h3>
            <label>
              更新源（latest-mac.yml）
              <input
                value={draft.updateFeedUrl}
                onChange={(event) => setDraft({ ...draft, updateFeedUrl: event.target.value })}
                placeholder="https://example.com/yuanfang/latest-mac.yml"
              />
            </label>
            <p className="muted small">打包版本启动后会检查更新；发现新版本先询问你，同意后下载并自动重启安装。</p>
            <button className="ghost-button small" onClick={() => void window.yuanfang.checkForUpdates()}>
              立即检查更新
            </button>
          </section>

          <section className="settings-section">
            <h3>工作区</h3>
            <div className="workspace-row">
              <code>{config.workspace}</code>
              <button className="ghost-button" onClick={() => void onOpenWorkspace()}>
                在 Finder 中打开
              </button>
            </div>
            <div className="muted small">项目默认创建在 {config.defaultProjectDir}</div>
          </section>

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
        </div>

        {error === null ? null : <div className="form-error">{error}</div>}
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
