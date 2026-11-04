import { useEffect, useMemo, useState } from "react";
import type { ModelOption, ProviderModelsResult, ProviderView } from "@yuanfang/shared";
import { api } from "../lib/api";
import { formatTokens } from "../lib/format";

type ModelTarget = "system" | "project" | "role";

export function CredentialsSection({
  onPickModel,
}: {
  onPickModel: (target: ModelTarget, provider: string, modelId: string) => void;
}) {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [detail, setDetail] = useState<ProviderModelsResult | null>(null);
  const [query, setQuery] = useState("");
  const [key, setKey] = useState("");
  const [envText, setEnvText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadProviders = async (preferred?: string) => {
    const list = await api.getProviders();
    setProviders(list);
    const next =
      preferred !== undefined
        ? preferred
        : selectedId.length > 0 && list.some((provider) => provider.id === selectedId)
          ? selectedId
          : list.find((provider) => provider.configured)?.id ?? list[0]?.id ?? "";
    setSelectedId(next);
    if (next.length > 0) await loadModels(next, false);
  };

  const loadModels = async (providerId: string, refresh: boolean) => {
    try {
      const result = await api.getProviderModels({ providerId, refresh });
      setDetail(result);
      setError(result.errors.length > 0 ? result.errors.join("\n") : null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  useEffect(() => {
    void loadProviders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return providers;
    return providers.filter(
      (provider) =>
        provider.name.toLowerCase().includes(needle) ||
        provider.id.toLowerCase().includes(needle) ||
        (provider.apiKeyName ?? "").toLowerCase().includes(needle),
    );
  }, [providers, query]);

  const select = async (providerId: string) => {
    setSelectedId(providerId);
    setKey("");
    setEnvText("");
    setError(null);
    setNotice(null);
    await loadModels(providerId, false);
  };

  const save = async () => {
    if (detail === null) return;
    let env: Record<string, string> | undefined;
    if (envText.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(envText);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("环境变量必须是 JSON 对象");
        }
        env = Object.fromEntries(Object.entries(parsed).map(([field, value]) => [field, String(value)]));
      } catch (caught) {
        setError(`环境变量解析失败：${caught instanceof Error ? caught.message : String(caught)}`);
        return;
      }
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.saveProviderKey({
        providerId: detail.provider.id,
        key,
        ...(env === undefined ? {} : { env }),
      });
      setDetail(result);
      setKey("");
      setProviders((current) =>
        current.map((provider) => (provider.id === result.provider.id ? result.provider : provider)),
      );
      setNotice(
        result.models.length > 0
          ? `已保存，拉取到 ${result.models.length} 个模型`
          : "已保存，但没有拉取到模型；检查 Key 或点刷新",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (detail === null) return;
    if (!window.confirm(`删除 ${detail.provider.name} 在远方的 API Key？`)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.removeProviderKey(detail.provider.id);
      setDetail(result);
      setProviders((current) =>
        current.map((provider) => (provider.id === result.provider.id ? result.provider : provider)),
      );
      setNotice("已删除远方保存的凭据");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const provider = detail?.provider;
  const models: ModelOption[] = detail?.models ?? [];

  return (
    <section className="settings-section">
      <h3>厂商与凭据</h3>
      <p className="muted small">
        凭据会写入 ~/.yuanfang/auth.json（600）。如果某项来自 Pi，会标为「来自 Pi」，这里不会删除 Pi 的登录。
      </p>
      <p className="muted small">点模型行的「系统 / 项目 / 角色」会填入上方对应模型，保存设置后生效。</p>
      <div className="credentials-layout">
        <div className="provider-column">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索厂商…" />
          <div className="provider-list">
            {filtered.map((item) => (
              <button
                key={item.id}
                className={`provider-item ${item.id === selectedId ? "active" : ""}`}
                onClick={() => void select(item.id)}
              >
                <span className={`provider-dot ${item.configured ? "configured" : ""}`} />
                <span className="provider-item-main">
                  <strong>{item.name}</strong>
                  <span>{item.apiKeyName ?? item.oauthName ?? item.id}</span>
                </span>
                {item.configured ? <span className="provider-badge">已配置</span> : null}
              </button>
            ))}
            {filtered.length === 0 ? <div className="muted small">没有匹配的厂商。</div> : null}
          </div>
        </div>

        <div className="provider-detail">
          {provider === undefined ? (
            <div className="transcript-empty">选择左侧厂商查看设置。</div>
          ) : (
            <>
              <div className="provider-detail-head">
                <div>
                  <h4>{provider.name}</h4>
                  <div className="provider-meta">
                    <span className={`chip ${provider.configured ? "done" : "muted"}`}>
                      {provider.configured ? `已配置${provider.source ? ` · ${provider.source}` : ""}` : "未配置"}
                    </span>
                    <span className="chip muted">
                      {provider.origin === "pi"
                        ? "来自 Pi"
                        : provider.origin === "env"
                          ? "来自环境变量"
                          : provider.origin === "yuanfang"
                            ? "远方保存"
                            : "无凭据"}
                    </span>
                    <span className="muted small">{provider.modelCount} 个已知模型</span>
                  </div>
                </div>
                <button className="ghost-button small" disabled={busy} onClick={() => void loadModels(provider.id, true)}>
                  刷新模型
                </button>
              </div>

              {provider.apiKeyName !== null ? (
                <div className="credential-form">
                  <label>
                    {provider.apiKeyName}
                    <input
                      type="password"
                      value={key}
                      onChange={(event) => setKey(event.target.value)}
                      placeholder={provider.configured ? "已配置；输入新 Key 可覆盖" : "粘贴 API Key"}
                      autoComplete="off"
                    />
                  </label>
                  <label>
                    额外环境变量（可选，JSON）
                    <textarea
                      value={envText}
                      onChange={(event) => setEnvText(event.target.value)}
                      rows={2}
                      placeholder={'{"CLOUDFLARE_ACCOUNT_ID":"..."}'}
                    />
                  </label>
                  <div className="credential-actions">
                    {provider.origin === "yuanfang" ? (
                      <button className="ghost-button danger" disabled={busy} onClick={() => void remove()}>
                        删除远方凭据
                      </button>
                    ) : null}
                    <button className="primary-button" disabled={busy || key.trim().length === 0} onClick={() => void save()}>
                      {busy ? "保存中…" : "保存并拉取模型"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="conversation-note">
                  该厂商使用 OAuth。请先在 Pi 中完成登录，远方会自动复用 Pi 的凭据。
                </div>
              )}

              {error !== null ? <div className="form-error">{error}</div> : null}
              {notice !== null ? <div className="form-notice">{notice}</div> : null}

              <div className="provider-models">
                <div className="panel-header">
                  <h3>模型</h3>
                  <span className="muted small">{models.length} 个</span>
                </div>
                {models.length === 0 ? (
                  <div className="muted small">暂无模型。填写 Key 后点「保存并拉取模型」。</div>
                ) : (
                  <div className="provider-model-list">
                    {models.map((model) => (
                      <div key={`${model.provider}/${model.modelId}`} className="provider-model-row">
                        <div>
                          <strong>{model.name}</strong>
                          <span className="muted small"> {model.modelId}</span>
                          <div className="muted small">
                            {formatTokens(model.contextWindow)} ctx
                            {model.supportsImages ? " · 图片" : ""}
                          </div>
                        </div>
                        <div className="model-targets">
                          <button className="small-button" onClick={() => onPickModel("system", model.provider, model.modelId)}>
                            系统
                          </button>
                          <button className="small-button" onClick={() => onPickModel("project", model.provider, model.modelId)}>
                            项目
                          </button>
                          <button className="small-button" onClick={() => onPickModel("role", model.provider, model.modelId)}>
                            角色
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
