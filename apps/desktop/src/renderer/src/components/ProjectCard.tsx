import type { ProjectSummary } from "@yuanfang/shared";
import { formatDuration, formatPercent, formatRelative, formatTokens, truncate } from "../lib/format";

export function ProjectCard({ project, onOpen }: { project: ProjectSummary; onOpen: () => void }) {
  const done = project.taskCounts.done;
  const total = Object.values(project.taskCounts).reduce((sum, count) => sum + count, 0);
  const progress = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <button className={`project-card ${project.status === "archived" ? "archived" : ""}`} onClick={onOpen}>
      <div className="project-card-glow" style={{ background: project.color }} />
      <div className="project-card-top">
        <div className="project-title-row">
          <span className="project-dot" style={{ background: project.color }} />
          <h3>{project.name}</h3>
          {project.status === "paused" ? <span className="chip muted">已暂停</span> : null}
          {project.status === "archived" ? <span className="chip muted">已归档</span> : null}
        </div>
        <span className="project-updated" title={new Date(project.lastActiveAt).toLocaleString("zh-CN")}>
          {formatRelative(project.lastActiveAt)}
        </span>
      </div>
      <p className="project-brief">{truncate(project.brief, 140)}</p>
      <div className="project-progress">
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${progress}%`, background: project.color }} />
        </div>
        <span>
          {done}/{total || 0} 完成
        </span>
      </div>
      <div className="project-stats">
        <div>
          <strong>{formatDuration(project.totalMs)}</strong>
          <span>Agent 用时</span>
        </div>
        <div>
          <strong>{formatTokens(project.stats.billableTokens)}</strong>
          <span>Tokens</span>
        </div>
        <div>
          <strong>{formatPercent(project.stats.cacheHitRate)}</strong>
          <span>缓存命中</span>
        </div>
        <div>
          <strong className={project.activeTaskCount > 0 ? "accent" : ""}>{project.activeTaskCount}</strong>
          <span>进行中</span>
        </div>
      </div>
      <div className="project-card-footer">
        <span title={new Date(project.createdAt).toLocaleString("zh-CN")}>创建 {formatRelative(project.createdAt)}</span>
        <span title={new Date(project.updatedAt).toLocaleString("zh-CN")}>更新 {formatRelative(project.updatedAt)}</span>
        {project.pendingApprovalCount > 0 ? <span className="chip warning">{project.pendingApprovalCount} 待审批</span> : null}
      </div>
    </button>
  );
}
