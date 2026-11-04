import { useState } from "react";
import { api } from "../lib/api";

export function NewTaskModal({
  projectId,
  workflow,
  onClose,
  onCreated,
}: {
  projectId: string;
  workflow: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [role, setRole] = useState("执行");
  const [stage, setStage] = useState(workflow.includes("implement") ? "implement" : (workflow[0] ?? "implement"));
  const [files, setFiles] = useState("");
  const [dependsOn, setDependsOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (title.trim().length === 0 || brief.trim().length === 0) {
      setError("标题和任务说明都要填。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createTask({
        projectId,
        title: title.trim(),
        brief: brief.trim(),
        role: role.trim() || "执行",
        stage,
        files: files.split(",").map((item) => item.trim()).filter(Boolean),
        dependsOn: dependsOn.split(",").map((item) => item.trim()).filter(Boolean),
      });
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2>新建任务</h2>
            <p>项目负责人也会拆任务；这里用于你明确要补一个的情况。</p>
          </div>
          <button className="icon-button" onClick={onClose}>✕</button>
        </header>
        <div className="form">
          <label>
            标题
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：补齐设置页的空状态" autoFocus />
          </label>
          <label>
            任务说明
            <textarea value={brief} onChange={(event) => setBrief(event.target.value)} rows={5} placeholder="目标、产出、验收标准" />
          </label>
          <div className="form-row">
            <label>
              角色
              <input value={role} onChange={(event) => setRole(event.target.value)} placeholder="执行 / 前端 / 后端 / 测试…" />
            </label>
            <label>
              涉及文件（逗号分隔）
              <input value={files} onChange={(event) => setFiles(event.target.value)} placeholder="src/App.tsx, README.md" />
            </label>
          </div>
          <label>
            依赖任务 ID（逗号分隔，可选）
            <input value={dependsOn} onChange={(event) => setDependsOn(event.target.value)} />
          </label>
          {error === null ? null : <div className="form-error">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button className="ghost-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={busy} onClick={() => void submit()}>
            {busy ? "创建中…" : "创建任务"}
          </button>
        </footer>
      </div>
    </div>
  );
}
