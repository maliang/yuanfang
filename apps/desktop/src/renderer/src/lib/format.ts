import type { TaskStatus } from "@yuanfang/shared";

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`;
}

export function formatRelative(timestamp: number): string {
  if (!timestamp) return "—";
  const delta = Date.now() - timestamp;
  if (delta < 45_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))} 分钟前`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} 小时前`;
  if (delta < 7 * 86_400_000) return `${Math.round(delta / 86_400_000)} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export function formatDateTime(timestamp: number): string {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "待办",
  queued: "排队",
  running: "进行中",
  waiting: "等待",
  review: "待验收",
  done: "完成",
  failed: "失败",
  cancelled: "取消",
};

export function taskStatusClass(status: TaskStatus): string {
  return `status-${status}`;
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "远";
  return trimmed.slice(0, 2);
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
