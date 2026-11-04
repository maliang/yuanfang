import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentKind,
  Approval,
  ConversationFeed,
  NotificationRecord,
  FileLockInfo,
  ProjectDetail,
  ProjectSummary,
  RuntimeConfigView,
  RuntimeEvent,
  RuntimeStatus,
  TaskSummary,
} from "@yuanfang/shared";
import { api } from "./lib/api";
import { applyAccent, applyTheme, applyUiScale } from "./lib/appearance";
import { formatTokens } from "./lib/format";
import { formatHotkey } from "./lib/hotkey";
import { SidebarChat } from "./components/SidebarChat";
import { ProjectCard } from "./components/ProjectCard";
import { ProjectWorkspace } from "./components/ProjectWorkspace";
import { NewProjectModal } from "./components/NewProjectModal";
import { ApprovalsPanel } from "./components/ApprovalsPanel";
import { MemoryPanel } from "./components/MemoryPanel";
import { SkillsPanel } from "./components/SkillsPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { Toasts, type ToastItem } from "./components/Toasts";
import { NotificationsPanel } from "./components/NotificationsPanel";
import { QuickAsk } from "./components/QuickAsk";

type Panel = "approvals" | "notifications" | "memory" | "skills" | "settings" | "new-project" | null;

export function App() {
  const isQuick = new URLSearchParams(window.location.search).get("quick") === "1";
  return isQuick ? <QuickAsk /> : <MainApp />;
}

function emptyFeed(conversationId: string, kind: AgentKind, projectId: string | null): ConversationFeed {
  return { conversationId, kind, projectId, busy: false, messages: [], partial: null, tools: [] };
}

function MainApp() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [feeds, setFeeds] = useState<Record<string, ConversationFeed>>({});
  const [systemId, setSystemId] = useState("");
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [config, setConfig] = useState<RuntimeConfigView | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("yf.chatCollapsed") === "1");
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [locks, setLocks] = useState<FileLockInfo[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [unread, setUnread] = useState(0);
  const toastId = useRef(0);
  const refreshTimer = useRef<number | null>(null);
  const selectedProjectRef = useRef<string | null>(null);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const agentName = config?.agentName ?? "元芳";
  const quickAskHotkey = config?.quickAskHotkey ?? status?.quickAskHotkey ?? "CommandOrControl+Shift+Space";

  selectedProjectRef.current = selectedProjectId;

  const pushToast = useCallback((title: string, body: string, tone: ToastItem["tone"] = "info") => {
    const id = (toastId.current += 1);
    setToasts((current) => [...current.slice(-3), { id, title, body, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, tone === "error" ? 9000 : 6000);
  }, []);

  const loadFeed = useCallback(async (conversationId: string) => {
    const feed = await api.getConversation(conversationId);
    setFeeds((current) => ({ ...current, [conversationId]: feed }));
    return feed;
  }, []);

  const refreshProjects = useCallback(async () => {
    const list = await api.getProjects();
    setProjects(list);
  }, []);

  const refreshDetail = useCallback(async (projectId: string) => {
    const next = await api.getProject(projectId);
    if (next !== undefined) setDetail(next);
  }, []);

  const refreshApprovals = useCallback(async () => {
    setApprovals(await api.getApprovals());
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refreshProjects();
      const projectId = selectedProjectRef.current;
      if (projectId !== null) void refreshDetail(projectId);
    }, 350);
  }, [refreshDetail, refreshProjects]);

  const openProject = useCallback(
    async (projectId: string) => {
      setSelectedProjectId(projectId);
      setSelectedTaskId(null);
      const next = await api.getProject(projectId);
      if (next !== undefined) {
        setDetail(next);
        if (next.conversationId !== null) void loadFeed(next.conversationId);
      }
    },
    [loadFeed],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextStatus, nextProjects, system, nextApprovals, nextConfig, nextLocks, nextNotifications] = await Promise.all([
          api.getStatus(),
          api.getProjects(),
          api.getSystemConversation(),
          api.getApprovals(),
          api.getConfig(),
          api.getLocks(),
          api.getNotifications(),
        ]);
        if (cancelled) return;
        setStatus(nextStatus);
        setProjects(nextProjects);
        setApprovals(nextApprovals);
        setNotifications(nextNotifications);
        setConfig(nextConfig);
        setLocks(nextLocks);
        setSystemId(system.conversationId);
        setFeeds((current) => ({ ...current, [system.conversationId]: system.feed }));
      } catch (error) {
        if (!cancelled) {
          setStatus((current) => ({
            ready: false,
            booting: false,
            error: error instanceof Error ? error.message : String(error),
            warning: null,
            workspace: current?.workspace ?? "",
            startedAt: current?.startedAt ?? Date.now(),
            activeRuns: 0,
            pendingApprovals: 0,
            runningTasks: 0,
            quickAskHotkey: "CommandOrControl+Shift+Space",
          }));
        }
      }
      localStorage.setItem("yf.chatCollapsed", collapsed ? "1" : "0");
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const unsubscribe = api.onEvent((event: RuntimeEvent) => {
      switch (event.type) {
        case "status":
          setStatus(event.status);
          break;
        case "assistant_delta":
          setFeeds((current) => {
            const feed =
              current[event.conversationId] ??
              emptyFeed(event.conversationId, event.kind, event.projectId);
            return {
              ...current,
              [event.conversationId]: { ...feed, partial: event.text.length > 0 ? event.text : null },
            };
          });
          break;
        case "assistant_message":
        case "message_added": {
          const message = event.message;
          setFeeds((current) => {
            const feed =
              current[message.conversationId] ??
              emptyFeed(message.conversationId, message.agentKind, message.projectId);
            if (feed.messages.some((item) => item.id === message.id)) return current;
            return {
              ...current,
              [message.conversationId]: {
                ...feed,
                messages: [...feed.messages, message],
                partial: null,
              },
            };
          });
          if (collapsedRef.current && message.agentKind === "system" && message.role === "assistant") {
            setUnread((count) => count + 1);
          }
          scheduleRefresh();
          break;
        }
        case "agent_busy":
          setFeeds((current) => {
            const feed =
              current[event.conversationId] ??
              emptyFeed(event.conversationId, event.kind, event.projectId);
            return { ...current, [event.conversationId]: { ...feed, busy: event.busy } };
          });
          break;
        case "task_updated":
          setDetail((current) => {
            if (current === null || current.id !== event.task.projectId) return current;
            return {
              ...current,
              tasks: current.tasks.map((task) => (task.id === event.task.id ? event.task : task)),
            };
          });
          scheduleRefresh();
          break;
        case "project_updated": {
          setProjects((current) => {
            const exists = current.some((project) => project.id === event.project.id);
            return exists
              ? current.map((project) => (project.id === event.project.id ? event.project : project))
              : [event.project, ...current];
          });
          setDetail((current) =>
            current !== null && current.id === event.project.id ? { ...current, ...event.project } : current,
          );
          break;
        }
        case "approval_updated":
          void refreshApprovals();
          pushToast(
            event.approval.status === "approved"
              ? "已批准"
              : event.approval.status === "denied"
                ? "已拒绝"
                : "新的审批请求",
            event.approval.title,
            event.approval.status === "pending" ? "warning" : "info",
          );
          break;
        case "notification":
          pushToast(event.title, event.body, event.urgent ? "warning" : "info");
          void api.getNotifications().then(setNotifications);
          break;
        case "tool":
          setFeeds((current) => {
            const feed =
              current[event.conversationId] ??
              emptyFeed(event.conversationId, "system", null);
            const tools = feed.tools.filter((tool) => tool.callId !== event.callId);
            tools.push({
              callId: event.callId,
              name: event.name,
              status: event.status,
              ...(event.output === undefined ? {} : { output: event.output }),
            });
            return {
              ...current,
              [event.conversationId]: { ...feed, tools: tools.slice(-8) },
            };
          });
          break;
        case "locks":
          setLocks(event.locks);
          break;
        case "log":
          if (event.level === "error") pushToast("运行错误", event.message, "error");
          break;
        default:
          break;
      }
    });
    const unsubscribeNavigate = api.onNavigate((target) => {
      if (target.view === "project" && target.projectId !== undefined) {
        void openProject(target.projectId);
      } else if (target.view === "chat") {
        setSelectedProjectId(null);
        setCollapsed(false);
        if (target.messageId !== undefined) {
          setTimeout(() => {
            document.getElementById(`message-${target.messageId}`)?.scrollIntoView({ block: "center" });
          }, 250);
        }
      } else if (target.view === "notifications") {
        setPanel("notifications");
        void api.markNotificationsRead().then(() => api.getNotifications().then(setNotifications));
      } else if (target.view === "settings") setPanel("settings");
      else if (target.view === "approvals") setPanel("approvals");
      else if (target.view === "memory") setPanel("memory");
      else if (target.view === "skills") setPanel("skills");
    });
    return () => {
      unsubscribe();
      unsubscribeNavigate();
    };
  }, [openProject, pushToast, refreshApprovals, scheduleRefresh]);

  useEffect(() => {
    localStorage.setItem("yf.chatCollapsed", collapsed ? "1" : "0");
    if (!collapsed) setUnread(0);
  }, [collapsed]);

  useEffect(() => {
    document.title = agentName;
  }, [agentName]);

  useEffect(() => {
    if (config === null) return;
    const cleanup = applyTheme(config.theme);
    applyAccent(config.accent);
    applyUiScale(config.uiScale);
    return cleanup;
  }, [config?.theme, config?.accent, config?.uiScale]);

  useEffect(() => {
    if (selectedProjectId === null) {
      setDetail(null);
      return;
    }
    void refreshDetail(selectedProjectId);
  }, [selectedProjectId, refreshDetail]);

  const sendChat = useCallback(async (text: string) => {
    await api.sendChat({ text });
    const system = await api.getSystemConversation();
    setFeeds((current) => ({ ...current, [system.conversationId]: system.feed }));
  }, []);

  const stopSystem = useCallback(async () => {
    if (systemId.length === 0) return;
    try {
      await api.abortConversation(systemId);
      pushToast("已停止", "当前运行已中断，你可以继续发消息。", "warning");
    } catch (error) {
      pushToast("停止失败", error instanceof Error ? error.message : String(error), "error");
    }
  }, [pushToast, systemId]);

  const acceptTask = useCallback(
    async (taskId: string, note?: string) => {
      await api.acceptTask({ taskId, ...(note === undefined ? {} : { note }) });
      const projectId = selectedProjectRef.current;
      if (projectId !== null) await refreshDetail(projectId);
      await refreshProjects();
      pushToast("验收通过", "任务已标记为完成。");
    },
    [pushToast, refreshDetail, refreshProjects],
  );

  const rejectTask = useCallback(
    async (taskId: string, note: string) => {
      await api.rejectTask({ taskId, note });
      const projectId = selectedProjectRef.current;
      if (projectId !== null) await refreshDetail(projectId);
      await refreshProjects();
      pushToast("已退回", "任务回到 todo，可修改后重新派发。", "warning");
    },
    [pushToast, refreshDetail, refreshProjects],
  );

  const retryTask = useCallback(
    async (taskId: string) => {
      try {
        await api.retryTask(taskId);
        const projectId = selectedProjectRef.current;
        if (projectId !== null) await refreshDetail(projectId);
        await refreshProjects();
        pushToast("已重新派发", "角色 Agent 已再次启动。");
      } catch (error) {
        pushToast("重试失败", error instanceof Error ? error.message : String(error), "error");
      }
    },
    [pushToast, refreshDetail, refreshProjects],
  );

  const openTask = useCallback(
    async (task: TaskSummary) => {
      setSelectedTaskId(task.id);
      if (task.conversationId !== null) await loadFeed(task.conversationId);
    },
    [loadFeed],
  );

  const visibleProjects = useMemo(() => {
    const needle = projectQuery.trim().toLowerCase();
    return projects.filter((project) => {
      if (!showArchived && project.status === "archived") return false;
      if (needle.length === 0) return true;
      return (
        project.name.toLowerCase().includes(needle) ||
        project.brief.toLowerCase().includes(needle)
      );
    });
  }, [projects, showArchived, projectQuery]);
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending").length;
  const systemFeed = feeds[systemId] ?? null;
  const archivedCount = projects.filter((project) => project.status === "archived").length;

  return (
    <div className={`app-shell ${collapsed ? "chat-collapsed" : ""}`}>
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />

      <header className="topbar">
        <div className="topbar-left">
          <span className="logo-mark" />
          <span className="wordmark">{agentName}</span>
          <span className="topbar-divider" />
          <nav className="topbar-nav">
            <button className={selectedProjectId === null && panel === null ? "active" : ""} onClick={() => { setSelectedProjectId(null); setPanel(null); }}>
              项目
            </button>
            <button className={panel === "approvals" ? "active" : ""} onClick={() => setPanel("approvals")}>
              审批{pendingApprovals > 0 ? <span className="nav-badge">{pendingApprovals}</span> : null}
            </button>
            <button
              className={panel === "notifications" ? "active" : ""}
              onClick={() => {
                setPanel("notifications");
                void api.markNotificationsRead().then(() => api.getNotifications().then(setNotifications));
              }}
            >
              通知{notifications.filter((notification) => !notification.read).length > 0 ? (
                <span className="nav-badge">{notifications.filter((notification) => !notification.read).length}</span>
              ) : null}
            </button>
            <button className={panel === "memory" ? "active" : ""} onClick={() => setPanel("memory")}>
              记忆
            </button>
            <button className={panel === "skills" ? "active" : ""} onClick={() => setPanel("skills")}>
              技能
            </button>
            <button className={panel === "settings" ? "active" : ""} onClick={() => setPanel("settings")}>
              设置
            </button>
          </nav>
        </div>
        <div className="topbar-right">
          {locks.length > 0 ? (
            <span className="lock-indicator" title={locks.map((lock) => `${lock.path} ← ${lock.owner}`).join("\n")}>
              <span className="lock-dot" /> {locks.length} 个文件锁
            </span>
          ) : null}
          <span className={`runtime-dot ${status?.ready ? "ready" : status?.error ? "error" : "booting"}`} />
          <span className="runtime-label">
            {status?.error
              ? "启动失败"
              : status?.ready
                ? `在线 · ${projects.reduce((sum, project) => sum + project.activeTaskCount, 0)} 任务运行`
                : "启动中…"}
          </span>
          <button className="primary-button compact" onClick={() => setPanel("new-project")}>
            + 新项目
          </button>
          <button className="icon-button" onClick={() => setCollapsed((value) => !value)} title={collapsed ? "展开对话" : "收起对话"}>
            {collapsed ? "«" : "»"}
          </button>
        </div>
      </header>

      <main className="main-area">
        <div className="content-area">
          {status?.error ? (
            <div className="boot-error">
              <h2>{agentName}没能启动</h2>
              <p>{status.error}</p>
              <p className="muted">检查 ~/.yuanfang/config.json、模型凭据和数据库文件。</p>
            </div>
          ) : null}
          {status?.warning ? (
            <div className="boot-warning">
              <strong>模型不可用</strong>
              <span>{status.warning}</span>
              <button className="ghost-button small" onClick={() => setPanel("settings")}>
                去设置凭据
              </button>
            </div>
          ) : null}

          {selectedProjectId !== null && detail !== null ? (
            <ProjectWorkspace
              agentName={agentName}
              detail={detail}
              feeds={feeds}
              selectedTaskId={selectedTaskId}
              onBack={() => {
                setSelectedProjectId(null);
                setSelectedTaskId(null);
              }}
              onStatus={async (next) => {
                await api.updateProject({ projectId: detail.id, status: next });
                await refreshProjects();
                await refreshDetail(detail.id);
              }}
              onOpenFolder={() => void api.openWorkspace(detail.path)}
              onDispatch={async (taskId) => {
                try {
                  await api.dispatchTask(taskId);
                  pushToast("任务已派发", "角色 Agent 已在后台开始工作。");
                } catch (caught) {
                  pushToast("派发失败", caught instanceof Error ? caught.message : String(caught), "error");
                }
                await refreshDetail(detail.id);
              }}
              onCancel={async (taskId) => {
                await api.cancelTask(taskId);
                await refreshDetail(detail.id);
              }}
              onOpenTask={(task) => void openTask(task)}
              onCloseTask={() => setSelectedTaskId(null)}
              onRefresh={() => {
                void refreshDetail(detail.id);
                void refreshProjects();
              }}
              onAcceptTask={acceptTask}
              onRejectTask={rejectTask}
              onRetryTask={retryTask}
              onDelete={async () => {
                await api.deleteProject(detail.id);
                setSelectedProjectId(null);
                setDetail(null);
                await refreshProjects();
                pushToast("项目已删除", "项目文件保留在磁盘上。");
              }}
              onIndex={async () => {
                const count = await api.indexProject(detail.id);
                pushToast("索引完成", `${count} 个文件`);
                await refreshDetail(detail.id);
              }}
            />
          ) : (
            <>
              {projects.length === 0 ? <section className="hero">
                <div>
                  <p className="hero-eyebrow">系统 Agent · 项目负责人 · 角色 Agent</p>
                  <h1>把一件事交给{agentName}，<br />然后去忙别的。</h1>
                  <p className="hero-sub">
                    它判断需求、创建项目、盯住进度。任务在后台并行，同一个文件会自动排队。你只需要和它说话。
                  </p>
                  <div className="hero-actions">
                    <button className="ghost-button" onClick={() => setCollapsed(false)}>
                      和{agentName}聊聊
                    </button>
                  </div>
                </div>
                <div className="hero-stats">
                  <div>
                    <strong>{projects.filter((project) => project.status === "active").length}</strong>
                    <span>活跃项目</span>
                  </div>
                  <div>
                    <strong>{projects.reduce((sum, project) => sum + project.activeTaskCount, 0)}</strong>
                    <span>进行中任务</span>
                  </div>
                  <div>
                    <strong>{formatTokens(projects.reduce((sum, project) => sum + project.stats.billableTokens, 0))}</strong>
                    <span>累计 Tokens</span>
                  </div>
                  <div>
                    <strong>{pendingApprovals}</strong>
                    <span>待审批</span>
                  </div>
                </div>
              </section> : null}

              <section className="projects-section">
                <div className="section-head">
                  <h2>项目</h2>
                  <div className="section-head-actions">
                    <input
                      className="project-search"
                      value={projectQuery}
                      onChange={(event) => setProjectQuery(event.target.value)}
                      placeholder="搜索项目…"
                    />
                    {archivedCount > 0 ? (
                      <button className="ghost-button small" onClick={() => setShowArchived((value) => !value)}>
                        {showArchived ? "隐藏归档" : `显示归档 (${archivedCount})`}
                      </button>
                    ) : null}
                    <span className="muted small">按最近活动排序</span>
                  </div>
                </div>
                {visibleProjects.length === 0 ? (
                  <div className="empty-projects">
                    <span className="logo-mark large" />
                    <h3>{archivedCount > 0 ? "没有活跃项目" : "还没有项目"}</h3>
                    <p>
                      {archivedCount > 0
                        ? "归档项目还在，点上面的「显示归档」可以回看。"
                        : `点右上角「+ 新项目」，或者直接告诉${agentName}你想做什么。`}
                    </p>
                  </div>
                ) : (
                  <div className="project-grid">
                    {visibleProjects.map((project) => (
                      <ProjectCard
                        key={project.id}
                        project={project}
                        isDefault={project.id === config?.defaultProjectId}
                        onOpen={() => void openProject(project.id)}
                      />
                    ))}
                  </div>
                )}
              </section>

              <footer className="app-footer">
                <span>按 {formatHotkey(quickAskHotkey)} 随时呼出快速提问</span>
                <span>{status?.workspace ?? "~/.yuanfang"}</span>
                <span>实时同步</span>
              </footer>
            </>
          )}
        </div>

        <SidebarChat
          agentName={agentName}
          feed={systemFeed}
          busy={systemFeed?.busy ?? false}
          ready={status?.ready ?? false}
          collapsed={collapsed}
          unread={unread}
          onToggle={setCollapsed}
          onSend={sendChat}
          onStop={stopSystem}
          quickAskHotkey={quickAskHotkey}
          onOpenQuickAsk={() => pushToast("快速提问", `按 ${formatHotkey(quickAskHotkey)} 呼出输入框`, "info")}
          onOpenSettings={() => setPanel("settings")}
        />
      </main>

      {panel === "new-project" ? (
        <NewProjectModal
          onClose={() => setPanel(null)}
          onCreate={async (input) => {
            const project = await api.createProject(input);
            await refreshProjects();
            setPanel(null);
            await openProject(project.id);
          }}
        />
      ) : null}
      {panel === "approvals" ? (
        <ApprovalsPanel
          approvals={approvals}
          onClose={() => setPanel(null)}
          onResolve={async (id, decision, note) => {
            await api.resolveApproval({ id, decision, note });
            await refreshApprovals();
            pushToast(decision === "approved" ? "已批准" : "已拒绝", "请求方会收到结果并继续处理。");
          }}
        />
      ) : null}
      {panel === "notifications" ? (
        <NotificationsPanel
          notifications={notifications}
          onClose={() => setPanel(null)}
          onMarkRead={() => {
            void api.markNotificationsRead().then(() => api.getNotifications().then(setNotifications));
          }}
          onOpen={(notification) => {
            setPanel(null);
            void api.markNotificationsRead().then(() => api.getNotifications().then(setNotifications));
            if (notification.projectId !== null) {
              void openProject(notification.projectId).then(() => {
                if (notification.taskId !== null) {
                  const task = notification.taskId;
                  setTimeout(() => {
                    const row = document.querySelector(`[data-task-id="${task}"]`) as HTMLElement | null;
                    row?.click();
                  }, 450);
                }
              });
            } else {
              setCollapsed(false);
              if (notification.messageId !== null) {
                setTimeout(() => {
                  document.getElementById(`message-${notification.messageId}`)?.scrollIntoView({ block: "center" });
                }, 250);
              }
            }
          }}
        />
      ) : null}
      {panel === "memory" ? <MemoryPanel projectId={selectedProjectId} onClose={() => setPanel(null)} /> : null}
      {panel === "skills" ? <SkillsPanel projectId={selectedProjectId} onClose={() => setPanel(null)} /> : null}
      {panel === "settings" && config !== null ? (
        <SettingsPanel
          config={config}
          onSave={async (input) => {
            const next = await api.updateConfig(input);
            setConfig(next);
            pushToast("设置已保存", "下一次请求生效。");
          }}
          onOpenWorkspace={() => api.openWorkspace(config.workspace)}
          onClose={() => setPanel(null)}
        />
      ) : null}

      <Toasts
        items={toasts}
        onDismiss={(id) => setToasts((current) => current.filter((item) => item.id !== id))}
      />
    </div>
  );
}
