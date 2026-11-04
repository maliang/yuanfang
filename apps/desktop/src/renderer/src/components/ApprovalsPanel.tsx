import { useState } from "react";
import type { Approval } from "@yuanfang/shared";
import { formatRelative } from "../lib/format";

const KIND_LABEL: Record<string, string> = {
  shell: "命令",
  install: "安装",
  mcp: "MCP",
  network: "网络",
  other: "其他",
};

export function ApprovalsPanel({
  approvals,
  onResolve,
  onClose,
}: {
  approvals: Approval[];
  onResolve: (id: string, decision: "approved" | "denied", note: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const pending = approvals.filter((approval) => approval.status === "pending");
  const resolved = approvals.filter((approval) => approval.status !== "pending");

  const resolve = async (approval: Approval, decision: "approved" | "denied") => {
    setBusy(approval.id);
    try {
      const note = notes[approval.id]?.trim() ?? "";
      await onResolve(approval.id, decision, note.length > 0 ? note : null);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2>审批</h2>
            <p>安装软件、接入 MCP、访问外部账号和危险命令都需要你点头。</p>
          </div>
          <div className="modal-header-actions">
            <span className={`chip ${pending.length > 0 ? "warning" : "muted"}`}>{pending.length} 待处理</span>
            <button className="icon-button" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>
        <div className="approval-list">
          {pending.length === 0 ? <div className="transcript-empty">没有待审批的事项。</div> : null}
          {pending.map((approval) => (
            <div key={approval.id} className="approval-card pending">
              <div className="approval-top">
                <div>
                  <span className={`chip kind-${approval.kind}`}>{KIND_LABEL[approval.kind] ?? approval.kind}</span>
                  <h3>{approval.title}</h3>
                </div>
                <span className="memory-time">{formatRelative(approval.createdAt)}</span>
              </div>
              <p>{approval.detail}</p>
              {typeof approval.payload.command === "string" ? (
                <pre className="command-preview">{approval.payload.command}</pre>
              ) : null}
              <div className="approval-meta">
                <span>来自 {approval.requestedBy === "system" ? "系统 Agent" : approval.requestedBy === "project" ? "项目负责人" : "角色 Agent"}</span>
                {approval.projectId !== null ? <span>项目 {approval.projectId}</span> : null}
              </div>
              <input
                className="approval-note"
                placeholder="给 Agent 的备注（可选）"
                value={notes[approval.id] ?? ""}
                onChange={(event) => setNotes((current) => ({ ...current, [approval.id]: event.target.value }))}
              />
              <div className="approval-actions">
                <button className="ghost-button danger" disabled={busy === approval.id} onClick={() => void resolve(approval, "denied")}>
                  拒绝
                </button>
                <button className="primary-button" disabled={busy === approval.id} onClick={() => void resolve(approval, "approved")}>
                  批准
                </button>
              </div>
            </div>
          ))}
          {resolved.length > 0 ? <div className="section-title">历史</div> : null}
          {resolved.map((approval) => (
            <div key={approval.id} className={`approval-card ${approval.status}`}>
              <div className="approval-top">
                <div>
                  <span className={`chip kind-${approval.kind}`}>{KIND_LABEL[approval.kind] ?? approval.kind}</span>
                  <h3>{approval.title}</h3>
                </div>
                <span className="memory-time">{formatRelative(approval.resolvedAt ?? approval.createdAt)}</span>
              </div>
              <div className="approval-meta">
                <span className={`chip ${approval.status === "approved" ? "done" : "failed"}`}>
                  {approval.status === "approved" ? "已批准" : approval.status === "denied" ? "已拒绝" : approval.status}
                </span>
                {approval.resolutionNote !== null ? <span>备注：{approval.resolutionNote}</span> : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
