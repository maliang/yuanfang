import { useEffect, useMemo, useState } from "react";
import type { ConversationFeed, MemoryEntry, ProjectDetail, TaskEvent, TaskStatus, TaskSummary } from "@yuanfang/shared";
import { api } from "../lib/api";
import { NewTaskModal } from "./NewTaskModal";
import { Markdown } from "./Markdown";
import {
  TASK_STATUS_LABEL,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelative,
  formatTokens,
  truncate,
} from "../lib/format";
import { ChatTranscript } from "./ChatTranscript";

interface Props {
  agentName: string;
  detail: ProjectDetail;
  feeds: Record<string, ConversationFeed>;
  selectedTaskId: string | null;
  onBack: () => void;
  onStatus: (status: "active" | "paused" | "archived") => Promise<void>;
  onOpenFolder: () => void;
  onDispatch: (taskId: string) => Promise<void>;
  onCancel: (taskId: string) => Promise<void>;
  onOpenTask: (task: TaskSummary) => void;
  onCloseTask: () => void;
  onRefresh: () => void;
  onAcceptTask: (taskId: string, note?: string) => Promise<void>;
  onRejectTask: (taskId: string, note: string) => Promise<void>;
  onRetryTask: (taskId: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onIndex: () => Promise<void>;
}

type Tab = "tasks" | "architecture" | "memory" | "conversation";

const ACTIVE: TaskStatus[] = ["running", "queued", "waiting", "review"];

export function ProjectWorkspace({
  agentName,
  detail,
  feeds,
  selectedTaskId,
  onBack,
  onStatus,
  onOpenFolder,
  onDispatch,
  onCancel,
  onOpenTask,
  onCloseTask,
  onRefresh,
  onAcceptTask,
  onRejectTask,
  onRetryTask,
  onDelete,
  onIndex,
}: Props) {
  const [tab, setTab] = useState<Tab>("tasks");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [showNewTask, setShowNewTask] = useState(false);

  const grouped = useMemo(() => {
    const active: TaskSummary[] = [];
    const todo: TaskSummary[] = [];
    const finished: TaskSummary[] = [];
    for (const task of detail.tasks) {
      if (ACTIVE.includes(task.status)) active.push(task);
      else if (task.status === "todo") todo.push(task);
      else finished.push(task);
    }
    return { active, todo, finished };
  }, [detail.tasks]);

  const selectedTask = detail.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const projectFeed = detail.conversationId === null ? null : (feeds[detail.conversationId] ?? null);
  const done = detail.taskCounts.done;
  const total = Object.values(detail.taskCounts).reduce((sum, count) => sum + count, 0);

  const act = async (key: string, action: () => Promise<void>) => {
    setBusyAction(key);
    try {
      await action();
      onRefresh();
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <section className="workspace">
      <header className="workspace-header">
        <button className="ghost-button back" onClick={onBack}>
          ← 所有项目
        </button>
        <div className="workspace-title">
          <span className="project-dot large" style={{ background: detail.color }} />
          <div>
            <h1>{detail.name}</h1>
            <p>{truncate(detail.brief, 220)}</p>
          </div>
        </div>
        <div className="workspace-actions">
          <span className={`chip status-${detail.status}`}>{detail.status === "active" ? "进行中" : detail.status === "paused" ? "已暂停" : "已归档"}</span>
          <button className="ghost-button" onClick={() => void onOpenFolder()}>
            打开目录
          </button>
          {detail.status === "active" ? (
            <>
              <button className="ghost-button" disabled={busyAction !== null} onClick={() => void act("pause", () => onStatus("paused"))}>
                暂停
              </button>
              <button
                className="ghost-button"
                disabled={busyAction !== null}
                onClick={() => {
                  if (window.confirm("归档后项目只读；角色任务未完成时仍会在后头继续。确定归档？")) {
                    void act("archive", () => onStatus("archived"));
                  }
                }}
              >
                归档
              </button>
            </>
          ) : (
            <button className="ghost-button" disabled={busyAction !== null} onClick={() => void act("resume", () => onStatus("active"))}>
              恢复
            </button>
          )}
          {detail.status === "archived" ? (
            <button
              className="ghost-button danger"
              disabled={busyAction !== null}
              onClick={() => {
                if (window.confirm(`删除项目「${detail.name}」？只会删除看板记录，不会删除项目文件。`)) {
                  void onDelete();
                }
              }}
            >
              删除看板
            </button>
          ) : null}
        </div>
      </header>

      <div className="stat-row">
        <Stat label="Agent 用时" value={formatDuration(detail.totalMs)} hint="负责人 + 角色执行时间（可能重叠）" />
        <Stat label="Tokens" value={formatTokens(detail.stats.billableTokens)} hint={`入 ${formatTokens(detail.stats.input)} · 出 ${formatTokens(detail.stats.output)}`} />
        <Stat label="缓存命中" value={formatPercent(detail.stats.cacheHitRate)} hint={`读 ${formatTokens(detail.stats.cacheRead)} · 写 ${formatTokens(detail.stats.cacheWrite)}`} />
        <Stat label="任务" value={`${done}/${total}`} hint={`${detail.activeTaskCount} 个进行中`} />
        <Stat label="成本" value={`$${detail.stats.cost.toFixed(2)}`} hint="按模型目录估算" />
      </div>

      <div className="workflow-row">
        <span className="muted small">流程</span>
        {detail.workflow.map((stage, index) => (
          <span key={`${stage}-${index}`} className="workflow-stage">
            {stage}
            {index < detail.workflow.length - 1 ? <em>→</em> : null}
          </span>
        ))}
      </div>

      <div className="workspace-tabs">
        {(
          [
            ["tasks", `任务 ${detail.tasks.length}`],
            ["architecture", "架构"],
            ["memory", `记忆 ${detail.memories.length}`],
            ["conversation", "项目对话"],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button key={key} className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
        <div className="workspace-tab-spacer" />
        <span className="workspace-updated">最后更新 {formatRelative(detail.lastActiveAt)}</span>
      </div>

      {tab === "tasks" ? (
        <div className="task-groups">
          <div className="task-group-head">
            <span className="muted small">任务由项目负责人拆解；你也可以手动补一个。</span>
            <button className="ghost-button small" onClick={() => setShowNewTask(true)}>
              + 新建任务
            </button>
          </div>
          {grouped.active.length > 0 ? (
            <TaskGroup
              title="进行中 / 待验收"
              tasks={grouped.active}
              busyAction={busyAction}
              onDispatch={onDispatch}
              onCancel={onCancel}
              onOpen={onOpenTask}
              onRetry={onRetryTask}
            />
          ) : null}
          {grouped.todo.length > 0 ? (
            <TaskGroup
              title="待办"
              tasks={grouped.todo}
              busyAction={busyAction}
              onDispatch={onDispatch}
              onCancel={onCancel}
              onOpen={onOpenTask}
              onRetry={onRetryTask}
            />
          ) : null}
          {grouped.finished.length > 0 ? (
            <TaskGroup
              title="已结束"
              tasks={grouped.finished}
              busyAction={busyAction}
              onDispatch={onDispatch}
              onCancel={onCancel}
              onOpen={onOpenTask}
              onRetry={onRetryTask}
            />
          ) : null}
          {detail.tasks.length === 0 ? <div className="transcript-empty">项目负责人还没有拆出任务。</div> : null}
        </div>
      ) : null}

      {tab === "architecture" ? (
        <div className="split-panels">
          <div className="panel">
            <div className="panel-header">
              <h3>顶层结构</h3>
              <button
                className="ghost-button"
                disabled={indexing}
                onClick={() => {
                  setIndexing(true);
                  void onIndex().finally(() => setIndexing(false));
                }}
              >
                {indexing ? "索引中…" : "重建索引"}
              </button>
            </div>
            <div className="dir-chips">
              {detail.topLevel.length === 0 ? <span className="muted">（空）</span> : null}
              {detail.topLevel.map((item) => (
                <span key={item} className={`dir-chip ${item.endsWith("/") ? "folder" : ""}`}>
                  {item}
                </span>
              ))}
            </div>
            <div className="panel-sub">{detail.path}</div>
          </div>
          <div className="panel">
            <div className="panel-header">
              <h3>README</h3>
            </div>
            <pre className="readme">{detail.readme.length > 0 ? detail.readme : "暂无 README。"}</pre>
          </div>
        </div>
      ) : null}

      {tab === "memory" ? <MemoryList memories={detail.memories} /> : null}

      {tab === "conversation" ? (
        <div className="panel conversation-panel">
          <div className="conversation-note">
            项目沟通由{agentName}负责。需要补充要求或介入，请在右侧对{agentName}说，它会转达给项目负责人。
          </div>
          <ChatTranscript feed={projectFeed} empty="项目负责人还没有说话。" />
        </div>
      ) : null}

      {showNewTask ? (
        <NewTaskModal
          projectId={detail.id}
          workflow={detail.workflow}
          onClose={() => setShowNewTask(false)}
          onCreated={() => {
            setShowNewTask(false);
            onRefresh();
          }}
        />
      ) : null}

      {selectedTask !== null ? (
        <TaskDetail
          task={selectedTask}
          workflow={detail.workflow}
          feed={selectedTask.conversationId === null ? null : (feeds[selectedTask.conversationId] ?? null)}
          onClose={onCloseTask}
          onDispatch={onDispatch}
          onCancel={onCancel}
          onAccept={onAcceptTask}
          onReject={onRejectTask}
          onRetry={onRetryTask}
          busy={busyAction !== null}
        />
      ) : null}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint === undefined ? null : <em>{hint}</em>}
    </div>
  );
}

function TaskGroup({
  title,
  tasks,
  onDispatch,
  onCancel,
  onOpen,
  onRetry,
  busyAction,
}: {
  title: string;
  tasks: TaskSummary[];
  onDispatch: (taskId: string) => Promise<void>;
  onCancel: (taskId: string) => Promise<void>;
  onOpen: (task: TaskSummary) => void;
  onRetry: (taskId: string) => Promise<void>;
  busyAction: string | null;
}) {
  return (
    <div className="task-group">
      <div className="task-group-title">
        {title} <span>{tasks.length}</span>
      </div>
      <div className="task-list">
        {tasks.map((task) => (
          <div key={task.id} data-task-id={task.id} className="task-row" onClick={() => onOpen(task)}>
            <div className={`task-status-bar status-${task.status}`} />
            <div className="task-main">
              <div className="task-title-line">
                <strong>{task.title}</strong>
                <span className={`chip ${task.status}`}>{TASK_STATUS_LABEL[task.status]}</span>
                <span className="chip muted">{task.stage}</span>
                <span className="role-badge">{task.role}</span>
              </div>
              <p>{truncate(task.brief, 160)}</p>
              {task.progress !== null ? <div className="task-progress">{truncate(task.progress, 180)}</div> : null}
              {task.error !== null ? <div className="task-error">{truncate(task.error, 180)}</div> : null}
              <div className="task-meta">
                <span>{formatDuration(task.durationMs)}</span>
                <span>{formatTokens(task.stats.billableTokens)} tok</span>
                <span>{formatPercent(task.stats.cacheHitRate)} 缓存</span>
                {task.files.length > 0 ? <span>{task.files.slice(0, 3).join(", ")}</span> : null}
                <span>{formatRelative(task.createdAt)}</span>
              </div>
            </div>
            <div className="task-actions" onClick={(event) => event.stopPropagation()}>
              {task.status === "todo" ? (
                <button
                  className="small-button"
                  disabled={busyAction !== null}
                  onClick={() => void onDispatch(task.id)}
                >
                  派发
                </button>
              ) : null}
              {["running", "queued", "waiting"].includes(task.status) ? (
                <button className="small-button danger" disabled={busyAction !== null} onClick={() => void onCancel(task.id)}>
                  取消
                </button>
              ) : null}
              {task.status === "failed" || task.status === "cancelled" ? (
                <button className="small-button" disabled={busyAction !== null} onClick={() => void onRetry(task.id)}>
                  重试
                </button>
              ) : null}
              {task.status === "review" ? (
                <button className="small-button" disabled={busyAction !== null} onClick={() => onOpen(task)}>
                  验收
                </button>
              ) : null}
              <button className="small-button ghost" onClick={() => onOpen(task)}>
                查看
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MemoryList({ memories }: { memories: MemoryEntry[] }) {
  if (memories.length === 0) return <div className="transcript-empty">还没有项目记忆。</div>;
  return (
    <div className="memory-grid">
      {memories.map((memory) => (
        <div key={memory.id} className="memory-card">
          <div className="memory-card-top">
            <span className={`chip ${memory.kind}`}>{memory.kind}</span>
            {memory.pinned ? <span className="chip pinned">置顶</span> : null}
            <span className="memory-time">{formatRelative(memory.updatedAt)}</span>
          </div>
          <h4>{memory.title}</h4>
          <p>{truncate(memory.body, 400)}</p>
        </div>
      ))}
    </div>
  );
}

function TaskDetail({
  task,
  workflow,
  feed,
  onClose,
  onDispatch,
  onCancel,
  onAccept,
  onReject,
  onRetry,
  busy,
}: {
  task: TaskSummary;
  workflow: string[];
  feed: ConversationFeed | null;
  onClose: () => void;
  onDispatch: (taskId: string) => Promise<void>;
  onCancel: (taskId: string) => Promise<void>;
  onAccept: (taskId: string, note?: string) => Promise<void>;
  onReject: (taskId: string, note: string) => Promise<void>;
  onRetry: (taskId: string) => Promise<void>;
  busy: boolean;
}) {
  const [note, setNote] = useState("");
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const finalStage = workflow.length > 0 ? workflow[workflow.length - 1] : null;
  const canAccept = finalStage === null || task.stage === finalStage;
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      const list = await api.getTaskEvents(task.id);
      if (!cancelled) setEvents(list);
    };
    void load();
    if (["queued", "running", "waiting", "review"].includes(task.status)) {
      timer = window.setInterval(() => void load(), 2_000);
    }
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [task.id, task.status]);

  return (
    <div className="task-detail-backdrop" onClick={onClose}>
      <div className="task-detail" onClick={(event) => event.stopPropagation()}>
        <header className="task-detail-header">
          <div>
            <div className="task-title-line">
              <h2>{task.title}</h2>
              <span className={`chip ${task.status}`}>{TASK_STATUS_LABEL[task.status]}</span>
              <span className="chip muted">{task.stage}</span>
              <span className="role-badge">{task.role}</span>
            </div>
            <p>{task.brief}</p>
          </div>
          <div className="task-detail-actions">
            {task.status === "todo" ? (
              <button className="primary-button" disabled={busy} onClick={() => void onDispatch(task.id)}>
                派发任务
              </button>
            ) : null}
            {["running", "queued", "waiting"].includes(task.status) ? (
              <button className="ghost-button danger" disabled={busy} onClick={() => void onCancel(task.id)}>
                取消任务
              </button>
            ) : null}
            {task.status === "failed" || task.status === "cancelled" ? (
              <button className="ghost-button" disabled={busy} onClick={() => void onRetry(task.id)}>
                重试
              </button>
            ) : null}
            <button className="icon-button" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>
        <div className="task-detail-stats">
          <span>用时 {formatDuration(task.durationMs)}</span>
          <span>Tokens {formatTokens(task.stats.billableTokens)}</span>
          <span>缓存 {formatPercent(task.stats.cacheHitRate)}</span>
          <span>模型 {task.model ?? "—"}</span>
          <span>创建 {formatDateTime(task.createdAt)}</span>
        </div>
        {task.files.length > 0 ? <div className="task-files">涉及文件：{task.files.join(", ")}</div> : null}
        {task.worktreePath !== null ? (
          <div className="task-files">独立工作区：{task.worktreePath}{task.worktreeBranch === null ? "" : ` · ${task.worktreeBranch}`}</div>
        ) : null}
        {task.status === "review" ? (
          <div className="review-box">
            <div className="review-title">等待验收</div>
            <p>
              核验产出后通过，或写清问题退回重做。
              {canAccept ? "" : ` 当前阶段是「${task.stage}」，需先推进到「${finalStage}」才能通过验收。`}
            </p>
            <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="验收备注 / 退回原因" />
            <div className="review-actions">
              <button
                className="ghost-button danger"
                disabled={busy || note.trim().length === 0}
                onClick={() => void onReject(task.id, note.trim())}
              >
                退回重做
              </button>
              <button className="primary-button" disabled={busy || !canAccept} onClick={() => void onAccept(task.id, note.trim() || undefined)}>
                通过验收
              </button>
            </div>
          </div>
        ) : null}
        {task.result !== null ? (
          <div className="task-result">
            <h3>结果</h3>
            <div className="task-result-body">
              <Markdown>{task.result}</Markdown>
            </div>
          </div>
        ) : null}
        {task.error !== null ? <div className="task-error block">{task.error}</div> : null}
        <div className="task-events">
          <h3>工具时间线</h3>
          {events.length === 0 ? (
            <div className="muted small">还没有工具调用记录。</div>
          ) : (
            <div className="event-timeline">
              {events.map((event) => {
                let diff: string | null = null;
                if (event.details !== null) {
                  try {
                    const parsed = JSON.parse(event.details) as { diff?: unknown; patch?: unknown };
                    if (typeof parsed.diff === "string") diff = parsed.diff;
                    else if (typeof parsed.patch === "string") diff = parsed.patch;
                  } catch {
                    // Not a structured detail.
                  }
                }
                return (
                  <div key={event.id} className={`event-item event-${event.status}`}>
                    <span className="event-dot" />
                    <div>
                      <div className="event-head">
                        <strong>{event.name}</strong>
                        <span className="memory-time">{formatRelative(event.createdAt)}</span>
                      </div>
                      {diff !== null ? <pre className="event-diff">{truncate(diff, 3000)}</pre> : null}
                      {event.output !== null && event.output.trim().length > 0 ? (
                        <pre className="event-output">{truncate(event.output, 1200)}</pre>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="task-transcript">
          <h3>角色对话</h3>
          <ChatTranscript feed={feed} empty={task.conversationId === null ? "任务尚未派发。" : "角色 Agent 还没有输出。"} />
        </div>
      </div>
    </div>
  );
}
