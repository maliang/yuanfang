import { useState } from "react";

export function NewProjectModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: { name: string; brief: string; path?: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (name.trim().length === 0 || brief.trim().length === 0) {
      setError("项目名和简介都要填。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        brief: brief.trim(),
        ...(path.trim().length > 0 ? { path: path.trim() } : {}),
      });
      onClose();
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
            <h2>新建项目</h2>
            <p>写清目标和边界。项目负责人会接手拆解，不需要你盯细节。</p>
          </div>
          <button className="icon-button" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="form">
          <label>
            项目名
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：灵感记录器" autoFocus />
          </label>
          <label>
            简介 / 目标 / 验收标准
            <textarea
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              rows={6}
              placeholder={"要做什么、给谁用、什么算完成。\n例如：做一个 macOS 菜单栏工具，随手记录灵感，本地存储，支持搜索。"}
            />
          </label>
          <label>
            工作目录（可选）
            <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="留空则自动创建到 ~/.yuanfang/projects" />
          </label>
          {error === null ? null : <div className="form-error">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button className="ghost-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" disabled={busy} onClick={() => void submit()}>
            {busy ? "创建中…" : "创建并启动"}
          </button>
        </footer>
      </div>
    </div>
  );
}
