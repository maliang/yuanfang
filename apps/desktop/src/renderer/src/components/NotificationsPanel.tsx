import type { NotificationRecord } from "@yuanfang/shared";
import { formatRelative } from "../lib/format";

export function NotificationsPanel({
  notifications,
  onOpen,
  onMarkRead,
  onClose,
}: {
  notifications: NotificationRecord[];
  onOpen: (notification: NotificationRecord) => void;
  onMarkRead: () => void;
  onClose: () => void;
}) {
  const unread = notifications.filter((notification) => !notification.read).length;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2>通知</h2>
            <p>审批、任务完成/失败、项目汇报和直接回复都会留在这里。</p>
          </div>
          <div className="modal-header-actions">
            <span className={`chip ${unread > 0 ? "warning" : "muted"}`}>{unread} 未读</span>
            <button className="ghost-button small" onClick={onMarkRead}>
              全部已读
            </button>
            <button className="icon-button" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>
        <div className="notification-list">
          {notifications.length === 0 ? <div className="transcript-empty">还没有通知。</div> : null}
          {notifications.map((notification) => (
            <button
              key={notification.id}
              className={`notification-card ${notification.read ? "read" : "unread"} ${notification.important ? "important" : ""}`}
              onClick={() => onOpen(notification)}
            >
              <div className="notification-head">
                <strong>{notification.title}</strong>
                <span className="memory-time">{formatRelative(notification.createdAt)}</span>
              </div>
              <p>{notification.body}</p>
              <div className="notification-meta">
                {notification.projectId !== null ? <span>项目</span> : null}
                {notification.taskId !== null ? <span>任务</span> : null}
                {notification.conversationId !== null ? <span>对话</span> : null}
                {notification.important ? <span className="chip warning">重要</span> : null}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
