import { useEffect, useMemo, useState } from "react";
import type { ModelOption, RoleDefinitionView } from "@yuanfang/shared";
import { api } from "../lib/api";

export function RolesSection({ availableModels }: { availableModels: ModelOption[] }) {
  const [roles, setRoles] = useState<RoleDefinitionView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState("inherit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async (preferred?: string) => {
    const list = await api.getRoles();
    setRoles(list);
    const next = preferred ?? selected ?? list[0]?.name ?? null;
    setSelected(next);
    const role = list.find((item) => item.name === next);
    if (role !== undefined) {
      setName(role.name);
      setDescription(role.description);
      setInstructions(role.instructions);
      setModel(role.model === null ? "inherit" : `${role.model.provider}/${role.model.modelId}`);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const providers = useMemo(() => {
    const map = new Map<string, ModelOption[]>();
    for (const entry of availableModels) {
      const list = map.get(entry.provider) ?? [];
      list.push(entry);
      map.set(entry.provider, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [availableModels]);

  const select = (role: RoleDefinitionView) => {
    setSelected(role.name);
    setName(role.name);
    setDescription(role.description);
    setInstructions(role.instructions);
    setModel(role.model === null ? "inherit" : `${role.model.provider}/${role.model.modelId}`);
    setError(null);
    setNotice(null);
  };

  const create = () => {
    setSelected(null);
    setName("");
    setDescription("");
    setInstructions("");
    setModel("inherit");
    setError(null);
    setNotice(null);
  };

  const save = async () => {
    if (name.trim().length === 0 || instructions.trim().length === 0) {
      setError("角色名和 instructions 都要填。");
      return;
    }
    let nextModel: { provider: string; modelId: string } | null = null;
    if (model !== "inherit") {
      const [provider, ...rest] = model.split("/");
      nextModel = { provider: provider ?? "", modelId: rest.join("/") };
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const list = await api.saveRole({
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
        model: nextModel,
      });
      setRoles(list);
      setSelected(name.trim());
      setNotice("角色已保存；下一次派发任务时生效");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h3>角色</h3>
      <p className="muted small">
        每个角色可以有自己的 instructions 和模型；模型选「继承」时使用角色 Agent 的默认模型。内置角色（包括「合规审查」）也可以直接修改并保存到 roles.json，下一次派发任务时生效。
      </p>
      <div className="roles-layout">
        <div className="role-list">
          <button className="ghost-button small" onClick={create}>
            + 新建角色
          </button>
          {roles.map((role) => (
            <button
              key={role.name}
              className={`role-item ${selected === role.name ? "active" : ""}`}
              onClick={() => select(role)}
            >
              <strong>{role.name}</strong>
              <span>{role.description || "（无描述）"}</span>
              <em>{role.model === null ? "继承默认模型" : `${role.model.provider}/${role.model.modelId}`}</em>
            </button>
          ))}
        </div>
        <div className="role-editor">
          <div className="form-row">
            <label>
              名称
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：性能工程师" />
            </label>
            <label>
              模型
              <select value={model} onChange={(event) => setModel(event.target.value)}>
                <option value="inherit">继承角色 Agent 默认模型</option>
                {providers.map(([provider, models]) => (
                  <optgroup key={provider} label={provider}>
                    {models.map((entry) => (
                      <option key={`${entry.provider}/${entry.modelId}`} value={`${entry.provider}/${entry.modelId}`}>
                        {entry.name}（{entry.modelId}）
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          </div>
          <label>
            描述
            <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="这个角色负责什么" />
          </label>
          <label>
            Instructions
            <textarea
              value={instructions}
              rows={9}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="角色行为、质量标准和边界。会注入角色 Agent。"
            />
          </label>
          {error === null ? null : <div className="form-error">{error}</div>}
          {notice === null ? null : <div className="form-notice">{notice}</div>}
          <div className="form-actions">
            <button className="primary-button" disabled={busy} onClick={() => void save()}>
              {busy ? "保存中…" : "保存角色"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
