import { createHash, randomUUID } from "node:crypto";
import type {
  AgentKind,
  AgentSummary,
  Approval,
  ApprovalKind,
  ApprovalStatus,
  ChatMessage,
  ChatRole,
  MemoryEntry,
  MemoryKind,
  NotificationRecord,
  ProjectStatus,
  ProjectSummary,
  TaskStatus,
  TaskSummary,
  TokenStats,
} from "@yuanfang/shared";
import type { Database } from "./db.js";

export const TASK_STATUSES: TaskStatus[] = [
  "todo",
  "queued",
  "running",
  "waiting",
  "review",
  "done",
  "failed",
  "cancelled",
];

const PROJECT_COLORS = [
  "#7c8cff",
  "#4fc3a1",
  "#f2a65a",
  "#e06c9f",
  "#63b3ed",
  "#b794f4",
  "#f6ad55",
  "#68d391",
];

export function uid(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base.length > 0 ? base : "project";
}

export function emptyStats(): TokenStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheHitRate: 0, totalTokens: 0, billableTokens: 0 };
}

export function makeStats(input: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}): TokenStats {
  const tokensIn = input.input ?? 0;
  const tokensOut = input.output ?? 0;
  const cacheRead = input.cacheRead ?? 0;
  const cacheWrite = input.cacheWrite ?? 0;
  const denominator = tokensIn + cacheRead + cacheWrite;
  return {
    input: tokensIn,
    output: tokensOut,
    cacheRead,
    cacheWrite,
    cost: input.cost ?? 0,
    cacheHitRate: denominator > 0 ? cacheRead / denominator : 0,
    totalTokens: tokensIn + tokensOut + cacheRead + cacheWrite,
    billableTokens: tokensIn + tokensOut,
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

interface ProjectRow {
  id: string;
  name: string;
  brief: string;
  path: string;
  status: ProjectStatus;
  color: string;
  conversation_id: string | null;
  created_at: number;
  updated_at: number;
  last_active_at: number;
  workflow: string;
  total_ms: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  cost: number;
}

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  brief: string;
  role: string;
  status: TaskStatus;
  model: string | null;
  conversation_id: string | null;
  durable_task_id: string | null;
  depends_on: string;
  files: string;
  stage: string;
  worktree_path: string | null;
  worktree_branch: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  cost: number;
  progress: string | null;
  error: string | null;
  result: string | null;
}

interface MemoryRow {
  uid: string;
  scope: string;
  kind: MemoryKind;
  title: string;
  body: string;
  tags: string;
  source: string;
  pinned: number;
  created_at: number;
  updated_at: number;
}

interface ApprovalRow {
  id: string;
  kind: ApprovalKind;
  title: string;
  detail: string;
  payload: string;
  status: ApprovalStatus;
  project_id: string | null;
  task_id: string | null;
  conversation_id: string | null;
  requested_by: string;
  created_at: number;
  resolved_at: number | null;
  resolution_note: string | null;
}

export interface ProjectRecord {
  id: string;
  name: string;
  brief: string;
  path: string;
  status: ProjectStatus;
  color: string;
  conversationId: string | null;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number;
  workflow: string[];
  totalMs: number;
}

export class AppStore {
  readonly db: Database;
  readonly #now: () => number;

  constructor(db: Database, now: () => number = Date.now) {
    this.db = db;
    this.#now = now;
  }

  close(): void {
    this.db.close();
  }

  // ── projects ──────────────────────────────────────────────────────────────

  createProject(input: {
    id: string;
    name: string;
    brief: string;
    path: string;
    conversationId?: string | null;
  }): ProjectRecord {
    const now = this.#now();
    const color = PROJECT_COLORS[hashIndex(input.name, PROJECT_COLORS.length)] ?? PROJECT_COLORS[0]!;
    this.db
      .prepare(
        `INSERT INTO projects (id, name, brief, path, status, color, conversation_id, created_at, updated_at, last_active_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.name, input.brief, input.path, color, input.conversationId ?? null, now, now, now);
    return this.getProjectRecord(input.id)!;
  }

  updateProjectIdentity(id: string, name: string, path: string): void {
    this.db
      .prepare("UPDATE projects SET name = ?, path = ?, updated_at = ?, last_active_at = ? WHERE id = ?")
      .run(name, path, this.#now(), this.#now(), id);
  }

  setProjectConversation(id: string, conversationId: string): void {
    this.db
      .prepare("UPDATE projects SET conversation_id = ?, updated_at = ? WHERE id = ?")
      .run(conversationId, this.#now(), id);
  }

  deleteProject(id: string): boolean {
    const result = this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    if (Number(result.changes) === 0) return false;
    this.db.prepare("DELETE FROM files WHERE project_id = ?").run(id);
    this.db.prepare("DELETE FROM approvals WHERE project_id = ?").run(id);
    this.db.prepare("DELETE FROM memories WHERE scope = ?").run(id);
    this.db.prepare("DELETE FROM conversation_usage WHERE project_id = ?").run(id);
    return true;
  }

  setProjectWorkflow(id: string, workflow: string[]): void {
    this.db
      .prepare("UPDATE projects SET workflow = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(workflow), this.#now(), id);
  }

  setProjectStatus(id: string, status: ProjectStatus): void {
    this.db.prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?").run(status, this.#now(), id);
  }

  touchProject(id: string): void {
    const now = this.#now();
    this.db.prepare("UPDATE projects SET updated_at = ?, last_active_at = ? WHERE id = ?").run(now, now, id);
  }

  getProjectRecord(id: string): ProjectRecord | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row === undefined ? undefined : projectFromRow(row);
  }

  getProjectByConversation(conversationId: string): ProjectRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE conversation_id = ?")
      .get(conversationId) as ProjectRow | undefined;
    return row === undefined ? undefined : projectFromRow(row);
  }

  listProjectRecords(includeArchived = false): ProjectRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM projects ${includeArchived ? "" : "WHERE status != 'archived'"} ORDER BY last_active_at DESC`,
      )
      .all() as unknown as ProjectRow[];
    return rows.map(projectFromRow);
  }

  projectSummary(record: ProjectRecord): ProjectSummary {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(record.id) as unknown as ProjectRow;
    const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<TaskStatus, number>;
    const taskRows = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM tasks WHERE project_id = ? GROUP BY status")
      .all(record.id) as unknown as Array<{ status: TaskStatus; count: number }>;
    for (const taskRow of taskRows) counts[taskRow.status] = Number(taskRow.count);
    const pending =
      (
        this.db
          .prepare("SELECT COUNT(*) AS count FROM approvals WHERE project_id = ? AND status = 'pending'")
          .get(record.id) as { count: number }
      ).count ?? 0;
    const active = counts.todo + counts.queued + counts.running + counts.waiting + counts.review;
    return {
      id: record.id,
      name: record.name,
      brief: record.brief,
      path: record.path,
      status: record.status,
      color: record.color,
      conversationId: record.conversationId,
      createdAt: record.createdAt,
      updatedAt: row.updated_at,
      lastActiveAt: row.last_active_at,
      workflow: parseJson<string[]>(row.workflow, ["design", "implement", "verify", "accept"]),
      totalMs: Number(row.total_ms),
      stats: makeStats({
        input: Number(row.tokens_in),
        output: Number(row.tokens_out),
        cacheRead: Number(row.cache_read),
        cacheWrite: Number(row.cache_write),
        cost: Number(row.cost),
      }),
      taskCounts: counts,
      activeTaskCount: active,
      pendingApprovalCount: Number(pending),
    };
  }

  addProjectUsage(
    projectId: string,
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number },
  ): void {
    if (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0) return;
    this.db
      .prepare(
        `UPDATE projects SET
          tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cache_read = cache_read + ?, cache_write = cache_write + ?,
          cost = cost + ?, updated_at = ? WHERE id = ?`,
      )
      .run(usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost, this.#now(), projectId);
  }

  addProjectTime(projectId: string, durationMs: number): void {
    if (durationMs <= 0) return;
    this.db
      .prepare("UPDATE projects SET total_ms = total_ms + ?, updated_at = ? WHERE id = ?")
      .run(Math.round(durationMs), this.#now(), projectId);
  }

  // ── tasks ────────────────────────────────────────────────────────────────

  createTask(input: {
    id: string;
    projectId: string;
    title: string;
    brief: string;
    role: string;
    dependsOn?: string[];
    files?: string[];
    stage?: string;
    model?: string | null;
  }): TaskRecord {
    const now = this.#now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, brief, role, status, model, depends_on, files, stage, created_at)
         VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.projectId,
        input.title,
        input.brief,
        input.role,
        input.model ?? null,
        JSON.stringify(input.dependsOn ?? []),
        JSON.stringify(input.files ?? []),
        input.stage ?? "implement",
        now,
      );
    this.touchProject(input.projectId);
    return this.getTaskRecord(input.id)!;
  }

  claimTaskForDispatch(id: string): boolean {
    const result = this.db.prepare("UPDATE tasks SET status = 'queued' WHERE id = ? AND status = 'todo'").run(id);
    return Number(result.changes) === 1;
  }

  updateTask(
    id: string,
    change: Partial<{
      title: string;
      brief: string;
      role: string;
      status: TaskStatus;
      conversationId: string | null;
      durableTaskId: string | null;
      startedAt: number | null;
      finishedAt: number | null;
      durationMs: number;
      progress: string | null;
      error: string | null;
      result: string | null;
      model: string | null;
      files: string[];
      dependsOn: string[];
      stage: string;
      worktreePath: string | null;
      worktreeBranch: string | null;
    }>,
  ): TaskRecord | undefined {
    const current = this.getTaskRecord(id);
    if (current === undefined) return undefined;
    const next = { ...current, ...change } as TaskRecord;
    this.db
      .prepare(
        `UPDATE tasks SET title = ?, brief = ?, role = ?, status = ?, conversation_id = ?, durable_task_id = ?,
          started_at = ?, finished_at = ?, duration_ms = ?, progress = ?, error = ?, result = ?, model = ?, files = ?,
          depends_on = ?, stage = ?, worktree_path = ?, worktree_branch = ? WHERE id = ?`,
      )
      .run(
        next.title,
        next.brief,
        next.role,
        next.status,
        next.conversationId,
        next.durableTaskId,
        next.startedAt,
        next.finishedAt,
        next.durationMs,
        next.progress,
        next.error,
        next.result,
        next.model,
        JSON.stringify(next.files),
        JSON.stringify(next.dependsOn),
        next.stage,
        next.worktreePath,
        next.worktreeBranch,
        id,
      );
    this.touchProject(next.projectId);
    return this.getTaskRecord(id);
  }

  setTaskProgress(id: string, progress: string): void {
    this.db.prepare("UPDATE tasks SET progress = ? WHERE id = ?").run(progress, id);
  }

  addTaskUsage(id: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }): void {
    this.db
      .prepare(
        `UPDATE tasks SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cache_read = cache_read + ?,
          cache_write = cache_write + ?, cost = cost + ? WHERE id = ?`,
      )
      .run(usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost, id);
  }

  getTaskRecord(id: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row === undefined ? undefined : taskFromRow(row);
  }

  getTaskByDurableId(durableTaskId: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE durable_task_id = ?").get(durableTaskId) as TaskRow | undefined;
    return row === undefined ? undefined : taskFromRow(row);
  }

  getTaskByConversation(conversationId: string): TaskRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE conversation_id = ? LIMIT 1")
      .get(conversationId) as TaskRow | undefined;
    return row === undefined ? undefined : taskFromRow(row);
  }

  listTaskRecords(projectId: string): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC")
      .all(projectId) as unknown as TaskRow[];
    return rows.map(taskFromRow);
  }

  listActiveTaskRecords(): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status IN ('queued', 'running', 'waiting') ORDER BY created_at ASC")
      .all() as unknown as TaskRow[];
    return rows.map(taskFromRow);
  }

  taskSummary(record: TaskRecord): TaskSummary {
    const now = this.#now();
    const liveDuration =
      record.status === "running" && record.startedAt !== null
        ? Math.max(0, now - record.startedAt)
        : record.durationMs;
    return {
      id: record.id,
      projectId: record.projectId,
      title: record.title,
      brief: record.brief,
      role: record.role,
      status: record.status,
      model: record.model,
      conversationId: record.conversationId,
      durableTaskId: record.durableTaskId,
      dependsOn: record.dependsOn,
      files: record.files,
      stage: record.stage,
      worktreePath: record.worktreePath,
      worktreeBranch: record.worktreeBranch,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationMs: liveDuration,
      stats: makeStats({
        input: record.tokensIn,
        output: record.tokensOut,
        cacheRead: record.cacheRead,
        cacheWrite: record.cacheWrite,
        cost: record.cost,
      }),
      progress: record.progress,
      error: record.error,
      result: record.result,
    };
  }

  appendTaskEvent(input: {
    taskId: string;
    callId: string;
    name: string;
    status: "running" | "done" | "error";
    output?: string | null;
    details?: string | null;
  }): void {
    const now = this.#now();
    this.db
      .prepare(
        `INSERT INTO task_events (task_id, call_id, name, status, output, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, call_id) DO UPDATE SET status = excluded.status, output = excluded.output,
           details = excluded.details`,
      )
      .run(input.taskId, input.callId, input.name, input.status, input.output ?? null, input.details ?? null, now);
  }

  listTaskEvents(taskId: string, limit = 200): Array<{
    id: number;
    taskId: string;
    callId: string;
    name: string;
    status: "running" | "done" | "error";
    output: string | null;
    details: string | null;
    createdAt: number;
  }> {
    const rows = this.db
      .prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY id ASC LIMIT ?")
      .all(taskId, limit) as unknown as Array<{
      id: number;
      task_id: string;
      call_id: string;
      name: string;
      status: "running" | "done" | "error";
      output: string | null;
      details: string | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: Number(row.id),
      taskId: row.task_id,
      callId: row.call_id,
      name: row.name,
      status: row.status,
      output: row.output,
      details: row.details,
      createdAt: Number(row.created_at),
    }));
  }

  // ── messages ─────────────────────────────────────────────────────────────

  appendMessage(input: {
    conversationId: string;
    agentKind: AgentKind;
    projectId?: string | null;
    role: ChatRole;
    content: string;
    meta?: Record<string, unknown> | null;
    entryKey?: string | null;
  }): ChatMessage | undefined {
    if (input.content.trim().length === 0 && input.role !== "event") return undefined;
    const now = this.#now();
    try {
      const result = this.db
        .prepare(
          `INSERT INTO messages (conversation_id, agent_kind, project_id, role, content, created_at, meta, entry_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.conversationId,
          input.agentKind,
          input.projectId ?? null,
          input.role,
          input.content,
          now,
          input.meta === undefined || input.meta === null ? null : JSON.stringify(input.meta),
          input.entryKey ?? null,
        );
      const id = Number(result.lastInsertRowid);
      return {
        id,
        conversationId: input.conversationId,
        agentKind: input.agentKind,
        projectId: input.projectId ?? null,
        role: input.role,
        content: input.content,
        createdAt: now,
        meta: input.meta ?? null,
      };
    } catch {
      // A duplicate entry key (watch re-attached) is expected.
      return undefined;
    }
  }

  listMessages(conversationId: string, limit = 300): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?")
      .all(conversationId, limit) as unknown as Array<{
      id: number;
      conversation_id: string;
      agent_kind: AgentKind;
      project_id: string | null;
      role: ChatRole;
      content: string;
      created_at: number;
      meta: string | null;
    }>;
    return rows.reverse().map((row) => ({
      id: Number(row.id),
      conversationId: row.conversation_id,
      agentKind: row.agent_kind,
      projectId: row.project_id,
      role: row.role,
      content: row.content,
      createdAt: Number(row.created_at),
      meta: parseJson<Record<string, unknown> | null>(row.meta, null),
    }));
  }

  // ── memories ─────────────────────────────────────────────────────────────

  addMemory(input: {
    scope: string;
    kind: MemoryKind;
    title: string;
    body: string;
    tags?: string[];
    source?: string;
    pinned?: boolean;
  }): MemoryEntry {
    const now = this.#now();
    // Explicit notes with the same scope + title are treated as updates, not
    // duplicates. Episodes only dedupe when the body is byte-identical.
    const existing = this.db
      .prepare("SELECT * FROM memories WHERE scope = ? AND title = ? LIMIT 1")
      .get(input.scope, input.title) as MemoryRow | undefined;
    if (existing !== undefined && (input.kind !== "episode" || existing.body === input.body)) {
      this.db
        .prepare(
          `UPDATE memories SET kind = ?, body = ?, tags = ?, source = ?, pinned = ?, updated_at = ? WHERE uid = ?`,
        )
        .run(
          input.kind,
          input.body,
          JSON.stringify(input.tags ?? parseJson<string[]>(existing.tags, [])),
          input.source ?? existing.source,
          input.pinned === undefined ? existing.pinned : input.pinned ? 1 : 0,
          now,
          existing.uid,
        );
      return this.getMemory(existing.uid)!;
    }
    const memoryUid = uid("mem");
    this.db
      .prepare(
        `INSERT INTO memories (uid, scope, kind, title, body, tags, source, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memoryUid,
        input.scope,
        input.kind,
        input.title,
        input.body,
        JSON.stringify(input.tags ?? []),
        input.source ?? "",
        input.pinned === true ? 1 : 0,
        now,
        now,
      );
    return this.getMemory(memoryUid)!;
  }

  getMemory(id: string): MemoryEntry | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE uid = ?").get(id) as MemoryRow | undefined;
    return row === undefined ? undefined : memoryFromRow(row);
  }

  updateMemory(
    id: string,
    change: Partial<{ title: string; body: string; tags: string[]; pinned: boolean }>,
  ): MemoryEntry | undefined {
    const current = this.getMemory(id);
    if (current === undefined) return undefined;
    const next = { ...current, ...change };
    this.db
      .prepare("UPDATE memories SET title = ?, body = ?, tags = ?, pinned = ?, updated_at = ? WHERE uid = ?")
      .run(
        next.title,
        next.body,
        JSON.stringify(next.tags),
        next.pinned ? 1 : 0,
        this.#now(),
        id,
      );
    return this.getMemory(id);
  }

  deleteMemory(id: string): boolean {
    const result = this.db.prepare("DELETE FROM memories WHERE uid = ?").run(id);
    return Number(result.changes) > 0;
  }

  listMemories(scope: string, limit = 100): MemoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE scope = ? OR scope = 'global'
         ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
      )
      .all(scope, limit) as unknown as MemoryRow[];
    return rows.map(memoryFromRow);
  }

  searchMemories(query: string, projectId: string | null, limit = 12): MemoryEntry[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) return this.listMemories(projectId ?? "global", limit);
    const scopes = projectId === null ? ["global"] : ["global", projectId];
    const like = `%${trimmed.replaceAll("%", "").replaceAll("_", "")}%`;
    const placeholders = scopes.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE scope IN (${placeholders}) AND (title LIKE ? OR body LIKE ? OR tags LIKE ?)
         ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
      )
      .all(...scopes, like, like, like, limit) as unknown as MemoryRow[];
    if (rows.length > 0) return rows.map(memoryFromRow);
    // Fall back to tokenized FTS for languages that tokenize on whitespace.
    try {
      const match = trimmed
        .split(/\s+/)
        .filter((token) => token.length > 0)
        .map((token) => `"${token.replaceAll('"', "")}"`)
        .join(" OR ");
      if (match.length === 0) return [];
      const ftsRows = this.db
        .prepare(
          `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
           WHERE memories_fts MATCH ? AND m.scope IN (${placeholders})
           ORDER BY rank LIMIT ?`,
        )
        .all(match, ...scopes, limit) as unknown as MemoryRow[];
      return ftsRows.map(memoryFromRow);
    } catch {
      return [];
    }
  }

  memoryDigest(projectId: string | null, limit = 24): MemoryEntry[] {
    const scopes = projectId === null ? ["global"] : ["global", projectId];
    const placeholders = scopes.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE scope IN (${placeholders}) AND kind != 'episode'
         ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
      )
      .all(...scopes, limit) as unknown as MemoryRow[];
    return rows.map(memoryFromRow);
  }

  recentEpisodes(projectId: string | null, limit = 6): MemoryEntry[] {
    const scopes = projectId === null ? ["global"] : ["global", projectId];
    const placeholders = scopes.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE scope IN (${placeholders}) AND kind = 'episode'
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...scopes, limit) as unknown as MemoryRow[];
    return rows.map(memoryFromRow);
  }

  // ── file index ───────────────────────────────────────────────────────────

  replaceFileIndex(
    projectId: string,
    entries: Array<{ path: string; size: number; mtime: number; language: string; summary: string }>,
  ): void {
    const now = this.#now();
    const insert = this.db.prepare(
      `INSERT INTO files (project_id, path, size, mtime, language, summary, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime,
         language = excluded.language, summary = excluded.summary, indexed_at = excluded.indexed_at`,
    );
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM files WHERE project_id = ?").run(projectId);
      for (const entry of entries) {
        insert.run(projectId, entry.path, entry.size, entry.mtime, entry.language, entry.summary, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  searchFiles(projectId: string, query: string, limit = 20): Array<{
    path: string;
    summary: string;
    language: string;
    score: number;
  }> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return (
        this.db
          .prepare("SELECT path, summary, language FROM files WHERE project_id = ? ORDER BY path LIMIT ?")
          .all(projectId, limit) as unknown as Array<{ path: string; summary: string; language: string }>
      ).map((row) => ({ ...row, score: 1 }));
    }
    const like = `%${trimmed.replaceAll("%", "").replaceAll("_", "")}%`;
    const rows = this.db
      .prepare(
        `SELECT path, summary, language,
          CASE WHEN path LIKE ? THEN 3 ELSE 0 END + CASE WHEN summary LIKE ? THEN 2 ELSE 0 END AS score
         FROM files WHERE project_id = ? AND (path LIKE ? OR summary LIKE ?)
         ORDER BY score DESC, path LIMIT ?`,
      )
      .all(like, like, projectId, like, like, limit) as unknown as Array<{
      path: string;
      summary: string;
      language: string;
      score: number;
    }>;
    return rows.map((row) => ({ ...row, score: Number(row.score) }));
  }

  fileCount(projectId: string): number {
    return (
      (this.db.prepare("SELECT COUNT(*) AS count FROM files WHERE project_id = ?").get(projectId) as { count: number })
        .count ?? 0
    );
  }

  // ── notifications ────────────────────────────────────────────────────────

  addNotification(input: {
    title: string;
    body: string;
    projectId?: string | null;
    taskId?: string | null;
    conversationId?: string | null;
    messageId?: number | null;
    important?: boolean;
  }): NotificationRecord {
    const now = this.#now();
    const result = this.db
      .prepare(
        `INSERT INTO notifications (title, body, project_id, task_id, conversation_id, message_id, important, read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        input.title,
        input.body,
        input.projectId ?? null,
        input.taskId ?? null,
        input.conversationId ?? null,
        input.messageId ?? null,
        input.important === true ? 1 : 0,
        now,
      );
    return this.getNotification(Number(result.lastInsertRowid))!;
  }

  getNotification(id: number): NotificationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : notificationFromRow(row);
  }

  listNotifications(limit = 80): NotificationRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as Array<Record<string, unknown>>;
    return rows.map(notificationFromRow);
  }

  markNotificationRead(id: number): void {
    this.db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(id);
  }

  markAllNotificationsRead(): void {
    this.db.prepare("UPDATE notifications SET read = 1 WHERE read = 0").run();
  }

  unreadNotificationCount(): number {
    return (
      (this.db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE read = 0").get() as { count: number })
        .count ?? 0
    );
  }

  // ── approvals ────────────────────────────────────────────────────────────

  createApproval(input: {
    kind: ApprovalKind;
    title: string;
    detail: string;
    payload?: Record<string, unknown>;
    projectId?: string | null;
    taskId?: string | null;
    conversationId?: string | null;
    requestedBy?: string;
  }): Approval {
    const approvalId = uid("apr");
    const now = this.#now();
    this.db
      .prepare(
        `INSERT INTO approvals (id, kind, title, detail, payload, status, project_id, task_id, conversation_id, requested_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(
        approvalId,
        input.kind,
        input.title,
        input.detail,
        JSON.stringify(input.payload ?? {}),
        input.projectId ?? null,
        input.taskId ?? null,
        input.conversationId ?? null,
        input.requestedBy ?? "",
        now,
      );
    return this.getApproval(approvalId)!;
  }

  getApproval(id: string): Approval | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
    return row === undefined ? undefined : approvalFromRow(row);
  }

  listApprovals(status?: ApprovalStatus): Approval[] {
    const rows = (
      status === undefined
        ? this.db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all()
        : this.db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC").all(status)
    ) as unknown as ApprovalRow[];
    return rows.map(approvalFromRow);
  }

  resolveApproval(id: string, status: "approved" | "denied", note: string | null): Approval | undefined {
    const result = this.db
      .prepare("UPDATE approvals SET status = ?, resolved_at = ?, resolution_note = ? WHERE id = ? AND status = 'pending'")
      .run(status, this.#now(), note, id);
    if (Number(result.changes) === 0) return undefined;
    return this.getApproval(id);
  }

  countPendingApprovals(): number {
    return (
      (this.db.prepare("SELECT COUNT(*) AS count FROM approvals WHERE status = 'pending'").get() as { count: number })
        .count ?? 0
    );
  }

  hasShellGrant(commandHash: string, projectId?: string | null, withinMs = 24 * 60 * 60 * 1000): boolean {
    const row = this.db
      .prepare(
        `SELECT id FROM approvals WHERE status = 'approved' AND kind IN ('shell', 'install')
         AND resolved_at >= ? AND json_extract(payload, '$.commandHash') = ?
         AND (
           ? IS NULL
           OR json_extract(payload, '$.projectId') IS NULL
           OR json_extract(payload, '$.projectId') = ?
         ) LIMIT 1`,
      )
      .get(this.#now() - withinMs, commandHash, projectId ?? null, projectId ?? null) as
      | { id: string }
      | undefined;
    return row !== undefined;
  }

  // ── usage sync ───────────────────────────────────────────────────────────

  syncConversationUsage(
    conversationId: string,
    projectId: string | null,
    totals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number },
  ): { delta: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } } {
    const previous = this.db
      .prepare("SELECT * FROM conversation_usage WHERE conversation_id = ?")
      .get(conversationId) as
      | {
          tokens_in: number;
          tokens_out: number;
          cache_read: number;
          cache_write: number;
          cost: number;
        }
      | undefined;
    const delta = {
      input: totals.input - Number(previous?.tokens_in ?? 0),
      output: totals.output - Number(previous?.tokens_out ?? 0),
      cacheRead: totals.cacheRead - Number(previous?.cache_read ?? 0),
      cacheWrite: totals.cacheWrite - Number(previous?.cache_write ?? 0),
      cost: totals.cost - Number(previous?.cost ?? 0),
    };
    if (delta.input === 0 && delta.output === 0 && delta.cacheRead === 0 && delta.cacheWrite === 0 && delta.cost === 0) {
      return { delta: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
    }
    this.db
      .prepare(
        `INSERT INTO conversation_usage (conversation_id, project_id, tokens_in, tokens_out, cache_read, cache_write, cost, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET project_id = excluded.project_id, tokens_in = excluded.tokens_in,
           tokens_out = excluded.tokens_out, cache_read = excluded.cache_read, cache_write = excluded.cache_write,
           cost = excluded.cost, updated_at = excluded.updated_at`,
      )
      .run(
        conversationId,
        projectId,
        totals.input,
        totals.output,
        totals.cacheRead,
        totals.cacheWrite,
        totals.cost,
        this.#now(),
      );
    this.addDailyUsage(delta.input + delta.output, delta.cost);
    if (projectId !== null) this.addProjectUsage(projectId, delta);
    return { delta };
  }

  addDailyUsage(tokens: number, cost: number): void {
    if (tokens === 0 && cost === 0) return;
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    this.db
      .prepare(
        `INSERT INTO usage_daily (day, tokens, cost) VALUES (?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET tokens = tokens + excluded.tokens, cost = cost + excluded.cost`,
      )
      .run(day, Math.max(0, Math.round(tokens)), Math.max(0, cost));
  }

  getDailyUsage(day = new Date(this.#now()).toISOString().slice(0, 10)): { day: string; tokens: number; cost: number } {
    const row = this.db.prepare("SELECT * FROM usage_daily WHERE day = ?").get(day) as
      | { day: string; tokens: number; cost: number }
      | undefined;
    return row === undefined
      ? { day, tokens: 0, cost: 0 }
      : { day: row.day, tokens: Number(row.tokens), cost: Number(row.cost) };
  }

  // ── agents ───────────────────────────────────────────────────────────────

  listAgents(projectId?: string, agentName = "元芳"): AgentSummary[] {
    const agents: AgentSummary[] = [];
    const systemConversation = this.getKv("system_conversation_id");
    agents.push({
      id: "system",
      kind: "system",
      name: agentName,
      conversationId: systemConversation ?? null,
      projectId: null,
      model: this.getKv("system_model") ?? null,
      busy: false,
      lastActiveAt: Number(this.getKv("system_last_active") ?? 0),
    });
    const projects =
      projectId === undefined
        ? this.listProjectRecords()
        : this.listProjectRecords().filter((project) => project.id === projectId);
    for (const project of projects) {
      agents.push({
        id: `project:${project.id}`,
        kind: "project",
        name: `${project.name} · 项目负责人`,
        conversationId: project.conversationId,
        projectId: project.id,
        model: this.getKv(`project_model:${project.id}`) ?? null,
        busy: false,
        lastActiveAt: project.lastActiveAt,
      });
      for (const task of this.listTaskRecords(project.id)) {
        if (task.conversationId === null) continue;
        agents.push({
          id: `role:${task.id}`,
          kind: "role",
          name: `${task.role} · ${task.title}`,
          conversationId: task.conversationId,
          projectId: project.id,
          model: task.model,
          busy: task.status === "running" || task.status === "waiting",
          lastActiveAt: task.startedAt ?? task.createdAt,
        });
      }
    }
    return agents;
  }

  // ── key/value ────────────────────────────────────────────────────────────

  getKv(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  appendEvent(kind: string, payload: unknown): void {
    this.db
      .prepare("INSERT INTO events (kind, payload, created_at) VALUES (?, ?, ?)")
      .run(kind, JSON.stringify(payload), this.#now());
  }
}

export interface TaskRecord {
  id: string;
  projectId: string;
  title: string;
  brief: string;
  role: string;
  status: TaskStatus;
  model: string | null;
  conversationId: string | null;
  durableTaskId: string | null;
  dependsOn: string[];
  files: string[];
  stage: string;
  worktreePath: string | null;
  worktreeBranch: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  progress: string | null;
  error: string | null;
  result: string | null;
}

function projectFromRow(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    brief: row.brief,
    path: row.path,
    status: row.status,
    color: row.color,
    conversationId: row.conversation_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastActiveAt: Number(row.last_active_at),
    workflow: parseJson<string[]>(row.workflow, ["design", "implement", "verify", "accept"]),
    totalMs: Number(row.total_ms),
  };
}

function taskFromRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    brief: row.brief,
    role: row.role,
    status: row.status,
    model: row.model,
    conversationId: row.conversation_id,
    durableTaskId: row.durable_task_id,
    dependsOn: parseJson<string[]>(row.depends_on, []),
    files: parseJson<string[]>(row.files, []),
    stage: row.stage ?? "implement",
    worktreePath: row.worktree_path,
    worktreeBranch: row.worktree_branch,
    createdAt: Number(row.created_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    durationMs: Number(row.duration_ms),
    tokensIn: Number(row.tokens_in),
    tokensOut: Number(row.tokens_out),
    cacheRead: Number(row.cache_read),
    cacheWrite: Number(row.cache_write),
    cost: Number(row.cost),
    progress: row.progress,
    error: row.error,
    result: row.result,
  };
}

function memoryFromRow(row: MemoryRow): MemoryEntry {
  return {
    id: row.uid,
    scope: row.scope,
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: parseJson<string[]>(row.tags, []),
    source: row.source,
    pinned: Number(row.pinned) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function notificationFromRow(row: Record<string, unknown>): NotificationRecord {
  return {
    id: Number(row.id),
    title: String(row.title),
    body: String(row.body),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    conversationId: row.conversation_id === null || row.conversation_id === undefined ? null : String(row.conversation_id),
    messageId: row.message_id === null || row.message_id === undefined ? null : Number(row.message_id),
    important: Number(row.important) === 1,
    read: Number(row.read) === 1,
    createdAt: Number(row.created_at),
  };
}

function approvalFromRow(row: ApprovalRow): Approval {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    status: row.status,
    projectId: row.project_id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    requestedBy: row.requested_by,
    createdAt: Number(row.created_at),
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    resolutionNote: row.resolution_note,
  };
}

export function hashCommand(command: string): string {
  return createHash("sha256").update(command.trim()).digest("hex").slice(0, 24);
}

function hashIndex(value: string, length: number): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash % length;
}
