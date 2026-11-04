import { useEffect, useState } from "react";
import type { SkillInfo } from "@yuanfang/shared";
import { formatRelative } from "../lib/format";

export function SkillsPanel({ projectId, onClose }: { projectId: string | null; onClose: () => void }) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selected, setSelected] = useState<{ name: string; description: string; content: string; scope: string; path: string } | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState<"global" | "project">(projectId === null ? "global" : "project");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    void window.yuanfang.getSkills({ projectId }).then(setSkills);
  };
  useEffect(load, [projectId]);

  const open = async (skill: SkillInfo) => {
    const document = await window.yuanfang.readSkill({ name: skill.name, projectId });
    if (document !== null) {
      setSelected(document);
      setName(document.name);
      setDescription(document.description);
      setBody(document.content);
      setScope(document.scope === "project" ? "project" : "global");
    }
  };

  const reset = () => {
    setSelected(null);
    setName("");
    setDescription("");
    setBody("");
  };

  const save = async () => {
    if (name.trim().length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await window.yuanfang.saveSkill({
        name: name.trim(),
        description: description.trim(),
        body,
        scope,
        projectId: scope === "project" ? projectId : null,
      });
      reset();
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2>技能</h2>
            <p>可复用的方法、约定和踩坑记录。系统与项目 Agent 会按需读取。</p>
          </div>
          <div className="modal-header-actions">
            <button className="primary-button" onClick={reset}>
              新建技能
            </button>
            <button className="icon-button" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>
        <div className="skills-layout">
          <div className="skill-list">
            {skills.map((skill) => (
              <button key={skill.path} className={`skill-item ${selected?.path === skill.path ? "active" : ""}`} onClick={() => void open(skill)}>
                <div>
                  <strong>{skill.name}</strong>
                  <span className={`chip ${skill.scope === "project" ? "project" : "muted"}`}>{skill.scope === "project" ? "项目" : "全局"}</span>
                </div>
                <p>{skill.description || "（无描述）"}</p>
                <span className="memory-time">{formatRelative(skill.updatedAt)}</span>
              </button>
            ))}
            {skills.length === 0 ? <div className="transcript-empty">还没有技能。</div> : null}
          </div>
          <div className="skill-editor">
            <div className="form-row">
              <label>
                名称
                <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：release-checklist" />
              </label>
              <label>
                范围
                <select value={scope} onChange={(event) => setScope(event.target.value as "global" | "project")}>
                  <option value="global">全局</option>
                  {projectId !== null ? <option value="project">当前项目</option> : null}
                </select>
              </label>
            </div>
            <label>
              描述
              <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="什么时候该用这个技能" />
            </label>
            <label>
              正文（Markdown）
              <textarea
                value={body}
                rows={18}
                onChange={(event) => setBody(event.target.value)}
                placeholder={"## 何时使用\n\n## 步骤\n\n## 验证\n\n## 常见坑"}
              />
            </label>
            {error === null ? null : <div className="form-error">{error}</div>}
            <div className="form-actions">
              <button className="primary-button" disabled={saving || name.trim().length === 0} onClick={() => void save()}>
                {saving ? "保存中…" : "保存技能"}
              </button>
              {selected !== null ? (
                <>
                  <button
                    className="ghost-button danger"
                    onClick={() => {
                      if (!window.confirm(`删除技能「${selected.name}」？`)) return;
                      void window.yuanfang
                        .deleteSkill({ name: selected.name, scope: selected.scope === "project" ? "project" : "global", projectId })
                        .then(() => {
                          reset();
                          load();
                        });
                    }}
                  >
                    删除技能
                  </button>
                  <span className="muted small">{selected.path}</span>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
