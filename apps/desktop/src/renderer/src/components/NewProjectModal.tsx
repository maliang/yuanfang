import { useState } from "react";
import type { DraftProjectBriefResult } from "@yuanfang/shared";
import { api } from "../lib/api";

type BriefMeta = Pick<DraftProjectBriefResult, "fileCount" | "existing" | "ai" | "warning">;

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

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
  const [briefMeta, setBriefMeta] = useState<BriefMeta | null>(null);
  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const generate = async (
    targetName = name,
    targetPath = path,
  ): Promise<DraftProjectBriefResult | null> => {
    if (targetName.trim().length === 0) {
      setError("先填项目名，AI 才能生成简介。");
      return null;
    }
    setGenerating(true);
    setError(null);
    setWarning(null);
    try {
      const result = await api.draftProjectBrief({
        name: targetName.trim(),
        ...(targetPath.trim().length > 0 ? { path: targetPath.trim() } : {}),
      });
      setBrief(result.brief);
      setBriefMeta(result);
      setWarning(result.warning);
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setGenerating(false);
    }
  };

  const chooseFolder = async () => {
    try {
      const selected = await api.chooseFolder(path.trim().length > 0 ? path.trim() : undefined);
      if (selected === null) return;
      setPath(selected);
      const nextName = name.trim().length > 0 ? name : folderName(selected);
      if (name.trim().length === 0) setName(nextName);
      await generate(nextName, selected);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const submit = async () => {
    if (name.trim().length === 0) {
      setError("项目名不能为空。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let finalBrief = brief.trim();
      if (finalBrief.length === 0) {
        const generated = await generate();
        finalBrief = generated?.brief.trim() ?? "";
      }
      if (finalBrief.length === 0) {
        setError("简介还没有生成，请点「AI 生成」或手动填写。");
        return;
      }
      await onCreate({
        name: name.trim(),
        brief: finalBrief,
        ...(path.trim().length > 0 ? { path: path.trim() } : {}),
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const busyNow = busy || generating;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal project-create-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2>新建项目</h2>
            <p>选择目录或输入项目名。AI 会先读一遍目录，写好简介，项目负责人再接手拆解。</p>
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
            项目位置
            <div className="path-row">
              <input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="留空则自动创建到 ~/.yuanfang/projects"
              />
              <button className="ghost-button small" disabled={busyNow} onClick={() => void chooseFolder()}>
                选择文件夹…
              </button>
            </div>
          </label>
          <p className="form-hint">
            选择已有目录时，会先扫描文件并让 AI 了解项目；新目录也可以直接创建。留空则由元芳自动分配位置。
          </p>
          <div className="field-label-row">
            <span>项目简介（AI 生成，可修改）</span>
            <button className="ghost-button small" disabled={busyNow} onClick={() => void generate()}>
              {generating ? "理解中…" : "✦ AI 生成"}
            </button>
          </div>
          <textarea
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            rows={7}
            placeholder="选择目录或填写项目名后，让 AI 生成；也可以直接写下当前理解。"
          />
          <div className="form-hint brief-meta">
            {generating
              ? "正在读取目录并让 AI 理解项目…"
              : briefMeta === null
                ? "简介只描述项目是什么、给谁用、当前状态；目标和验收标准会在任务里随进展调整。"
                : [
                    briefMeta.existing ? `已读取 ${briefMeta.fileCount} 个文件` : "新目录",
                    briefMeta.ai ? "AI 已填写" : "本地摘要",
                  ].join(" · ")}
          </div>
          {warning === null ? null : <div className="form-warning">{warning}</div>}
          {error === null ? null : <div className="form-error">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button className="ghost-button" onClick={onClose} disabled={busyNow}>
            取消
          </button>
          <button className="primary-button" disabled={busyNow} onClick={() => void submit()}>
            {busy ? "创建中…" : "创建并启动"}
          </button>
        </footer>
      </div>
    </div>
  );
}
