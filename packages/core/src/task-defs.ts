import { defineTask, type ConversationId, type TaskRuntime } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { RuntimeHost } from "./host.js";
import type { TaskRecord } from "./store.js";

export interface RoleRunInput {
  dbTaskId: string;
  roleConversationId: string;
  projectConversationId: string;
  projectId: string;
  title: string;
  role: string;
  brief: string;
  worktreePath?: string;
}

export type RoleRunState =
  | { phase: "deliver" }
  | {
      phase: "await_approval";
      approvalId: string;
      answer: string;
      failure?: string;
    }
  | {
      phase: "resume";
      approvalId: string;
      decision: "approved" | "denied";
      approvalTitle: string;
      failure?: string;
    }
  | { phase: "report"; outcome: "done" | "failed"; text: string; error?: string };

export interface TaskDeps {
  host: RuntimeHost;
  syncUsage(conversationId: string, projectId: string | null): Promise<void>;
  answerText(conversationId: string, answerId: import("@earendil-works/pi-durable").EntryId): Promise<string>;
}

const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "yuanfang.anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

function createRoleRun(deps: TaskDeps) {
  return defineTask<RoleRunInput, RoleRunState, null>({
    name: "yuanfang.role-run",
    version: 2,
    initial: () => ({ phase: "deliver" }),
    migrate: (input, checkpoint) => ({
      input: input as unknown as RoleRunInput,
      checkpoint: checkpoint as unknown as RoleRunState,
    }),
    phases: {
      deliver: async (task, runtime, context) => {
        const { host } = deps;
        const record = host.store.getTaskRecord(task.input.dbTaskId);
        if (record === undefined) {
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "failed", error: { message: "task record missing" } } }),
            context,
          );
          return;
        }
        if (isTerminal(record)) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
          return;
        }

        // Reserve every declared file for the whole task. A second task touching
        // the same file waits here, before its role agent starts, so it never
        // reads a stale file and plans a change against outdated content.
        if (record.files.length > 0 && record.worktreePath === null) {
          host.store.updateTask(record.id, { status: "waiting", progress: "等待文件锁" });
          host.notify({
            type: "task_updated",
            task: host.store.taskSummary(host.store.getTaskRecord(record.id)!),
          });
          await host.acquireTaskClaims(record.id, record.files, runtime.signal);
        }
        if (runtime.signal.aborted) return;

        const startedAt = record.startedAt ?? Date.now();
        host.store.updateTask(record.id, { status: "running", startedAt, progress: null });
        host.notify({
          type: "task_updated",
          task: host.store.taskSummary(host.store.getTaskRecord(record.id)!),
        });

        const conversation = await runtime.conversation(
          Number(task.input.roleConversationId) as ConversationId,
          context,
        );
        if (conversation === undefined) {
          await settleAnswer(deps, task, runtime, context, "角色对话不存在", "角色对话不存在");
          return;
        }
        const submission = await conversation.submit(
          {
            type: "input",
            content: buildRolePrompt(task.input),
            requestId: `role-run:${task.id}`,
            entry: { kind: "yf.task_brief", data: { taskId: task.input.dbTaskId } },
          },
          context,
        );
        const settled = await submission.wait(context);
        if (settled.status !== "done" || settled.answer === undefined) {
          await settleAnswer(
            deps,
            task,
            runtime,
            context,
            `任务未完成：${settled.reason}${settled.detail === undefined ? "" : ` · ${String(settled.detail)}`}`,
            `任务未完成：${settled.reason}`,
          );
          return;
        }
        const text = await deps.answerText(task.input.roleConversationId, settled.answer);
        await settleAnswer(deps, task, runtime, context, text, null);
      },

      await_approval: async (task, runtime, context) => {
        const { host } = deps;
        const state = task.state.checkpoint;
        const record = host.store.getTaskRecord(task.input.dbTaskId);
        if (record !== undefined && record.files.length > 0 && record.worktreePath === null) {
          await host.acquireTaskClaims(record.id, record.files, runtime.signal);
        }
        const approval = host.store.getApproval(state.approvalId);
        if (approval === undefined) {
          await settleAnswer(
            deps,
            task,
            runtime,
            context,
            "审批记录不存在",
            "审批记录不存在",
          );
          return;
        }
        if (approval.status === "pending") {
          host.store.updateTask(task.input.dbTaskId, {
            status: "waiting",
            progress: `等待审批：${approval.title}`,
          });
          await runtime.sleepUntil(Date.now() + 3_000, state, context);
          return;
        }
        const decision = approval.status === "approved" ? "approved" : "denied";
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: {
              phase: "resume",
              approvalId: state.approvalId,
              decision,
              approvalTitle: approval.title,
              ...(state.failure === undefined ? {} : { failure: state.failure }),
              ...(decision === "denied"
                ? { failure: state.failure ?? `审批被拒绝：${approval.title}` }
                : {}),
            } satisfies RoleRunState,
          }),
          context,
        );
      },

      resume: async (task, runtime, context) => {
        const { host } = deps;
        const state = task.state.checkpoint;
        const record = host.store.getTaskRecord(task.input.dbTaskId);
        if (record === undefined || record.status === "cancelled") {
          host.releaseTaskClaims(task.input.dbTaskId);
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
          return;
        }
        if (record.files.length > 0 && record.worktreePath === null) {
          await host.acquireTaskClaims(record.id, record.files, runtime.signal);
        }
        const conversation = await runtime.conversation(
          Number(task.input.roleConversationId) as ConversationId,
          context,
        );
        if (conversation === undefined) {
          await settleAnswer(deps, task, runtime, context, "角色对话不存在", "角色对话不存在");
          return;
        }
        const approval = host.store.getApproval(state.approvalId);
        const note = approval?.resolutionNote ?? "";
        const content = [
          `[审批结果] ${state.approvalTitle}`,
          `结果：${state.decision === "approved" ? "已批准" : "已拒绝"}`,
          note.length > 0 ? `备注：${note}` : "",
          "",
          state.decision === "approved"
            ? "现在可以继续完成原任务；完成后按原要求报告。"
            : "不要执行该操作。请说明替代方案或当前受阻状态，然后结束。",
        ]
          .filter((line) => line.length > 0)
          .join("\n");
        const submission = await conversation.submit(
          {
            type: "input",
            content,
            requestId: `role-approval:${task.id}:${state.approvalId}`,
            entry: { kind: "yf.approval_result", data: { approvalId: state.approvalId, status: state.decision } },
          },
          context,
        );
        const settled = await submission.wait(context);
        if (settled.status !== "done" || settled.answer === undefined) {
          await settleAnswer(
            deps,
            task,
            runtime,
            context,
            `审批后任务未完成：${settled.reason}`,
            state.failure ?? `审批后任务未完成：${settled.reason}`,
          );
          return;
        }
        const text = await deps.answerText(task.input.roleConversationId, settled.answer);
        await settleAnswer(deps, task, runtime, context, text, state.failure ?? null);
      },

      report: async (task, runtime, context) => {
        const state = task.state.checkpoint;
        const { host } = deps;
        const record = host.store.getTaskRecord(task.input.dbTaskId);
        if (record === undefined || (record.status !== "review" && record.status !== "failed")) {
          // Cancelled, accepted, or rejected by a human while report was pending:
          // do not send a stale "待验收" report.
          host.releaseTaskClaims(task.input.dbTaskId);
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
          return;
        }

        host.scheduleProjectIndex(task.input.projectId);
        if (state.outcome === "done") {
          host.store.addMemory({
            scope: task.input.projectId,
            kind: "episode",
            title: `任务待验收：${task.input.title}`,
            body: clip(state.text, 1800),
            tags: [task.input.role],
            source: `role:${task.input.role}`,
          });
          await host.messageProject(
            task.input.projectId,
            `[任务完成，待验收] ${task.input.title}\n角色：${task.input.role}\n\n${clip(state.text, 5000)}\n\n请核验产出；通过用 accept_task，退回用 reject_task。`,
            {
              entryKind: "yf.task_report",
              requestId: `role-report:${task.id}`,
              internal: true,
              meta: { taskId: task.input.dbTaskId, role: task.input.role, outcome: "review" },
            },
          );
          host.notify({
            type: "notification",
            title: `任务待验收：${task.input.title}`,
            body: clip(state.text, 180),
            projectId: task.input.projectId,
            taskId: task.input.dbTaskId,
            conversationId: task.input.projectConversationId,
            urgent: false,
          });
        } else {
          await host.messageProject(
            task.input.projectId,
            `[任务失败] ${task.input.title}\n角色：${task.input.role}\n\n${clip(state.text, 3000)}`,
            {
              entryKind: "yf.task_report",
              requestId: `role-report:${task.id}`,
              internal: true,
              meta: { taskId: task.input.dbTaskId, role: task.input.role, outcome: "failed" },
            },
          );
          host.notify({
            type: "notification",
            title: `任务失败：${task.input.title}`,
            body: clip(state.text, 180),
            projectId: task.input.projectId,
            taskId: task.input.dbTaskId,
            conversationId: task.input.projectConversationId,
            urgent: true,
            important: true,
          });
        }
        host.releaseTaskClaims(task.input.dbTaskId);
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          context,
        );
      },
    },
    abort: async (task, runtime, context) => {
      const { host } = deps;
      host.releaseTaskClaims(task.input.dbTaskId);
      const record = host.store.getTaskRecord(task.input.dbTaskId);
      if (record !== undefined && !isTerminal(record)) {
        host.store.updateTask(record.id, {
          status: "cancelled",
          finishedAt: Date.now(),
          error: "cancelled",
        });
        host.notify({
          type: "task_updated",
          task: host.store.taskSummary(host.store.getTaskRecord(record.id)!),
        });
      }
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
}

export function createTaskDefinitions(deps: TaskDeps): {
  Anchor: typeof Anchor;
  RoleRun: ReturnType<typeof createRoleRun>;
} {
  return { Anchor, RoleRun: createRoleRun(deps) };
}

/**
 * A role can stop to ask for approval. Rather than treating that as a finished
 * task, keep the durable reporter alive, wait for the approval, send the answer
 * back to the same role conversation, and then report the real result.
 */
async function settleAnswer(
  deps: TaskDeps,
  task: { input: RoleRunInput },
  runtime: TaskRuntime<RoleRunInput, RoleRunState, null, object>,
  context: Context,
  text: string,
  failure: string | null,
): Promise<void> {
  const { host } = deps;
  const pending = host.store
    .listApprovals("pending")
    .find(
      (approval) =>
        approval.taskId === task.input.dbTaskId ||
        (approval.taskId === null && approval.conversationId === task.input.roleConversationId),
    );
  if (pending !== undefined) {
    host.store.updateTask(task.input.dbTaskId, {
      status: "waiting",
      progress: `等待审批：${pending.title}`,
    });
    host.notify({
      type: "task_updated",
      task: host.store.taskSummary(host.store.getTaskRecord(task.input.dbTaskId)!),
    });
    await runtime.commit(
      () => ({
        status: "running",
        checkpoint: {
          phase: "await_approval",
          approvalId: pending.id,
          answer: text,
          ...(failure === null ? {} : { failure }),
        },
      }),
      context,
    );
    return;
  }

  const record = host.store.getTaskRecord(task.input.dbTaskId);
  if (record === undefined || record.status === "cancelled") {
    host.releaseTaskClaims(task.input.dbTaskId);
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    return;
  }

  const error = failure;
  const updated = await markFinished(deps, task.input, text, error);
  if (!updated) {
    host.releaseTaskClaims(task.input.dbTaskId);
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    return;
  }
  await runtime.commit(
    () => ({
      status: "running",
      checkpoint: {
        phase: "report",
        outcome: error === null ? "done" : "failed",
        text,
        ...(error === null ? {} : { error }),
      },
    }),
    context,
  );
}

async function markFinished(
  deps: TaskDeps,
  input: RoleRunInput,
  result: string,
  error: string | null,
): Promise<boolean> {
  const { host } = deps;
  const record = host.store.getTaskRecord(input.dbTaskId);
  if (record === undefined || record.status === "cancelled") return false;
  const now = Date.now();
  const duration = record.startedAt === null ? 0 : Math.max(0, now - record.startedAt);
  host.store.updateTask(record.id, {
    // A role finishing is not acceptance: the project lead must accept or reject.
    status: error === null ? "review" : "failed",
    finishedAt: now,
    durationMs: duration,
    result: result.length > 0 ? clip(result, 20000) : null,
    error,
  });
  host.store.addProjectTime(input.projectId, duration);
  host.releaseTaskClaims(input.dbTaskId);
  try {
    await deps.syncUsage(input.roleConversationId, input.projectId);
  } catch {
    // Stats are best effort; the task result is already durable.
  }
  const updated = host.store.getTaskRecord(record.id);
  if (updated !== undefined) host.notify({ type: "task_updated", task: host.store.taskSummary(updated) });
  return true;
}

function buildRolePrompt(input: RoleRunInput): string {
  return [
    `任务：${input.title}`,
    `角色：${input.role}`,
    "",
    input.brief,
    "",
    "完成后请给出：改动摘要、验证方式、剩余风险。",
  ].join("\n");
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function isTerminal(task: TaskRecord): boolean {
  return task.status === "done" || task.status === "failed" || task.status === "cancelled";
}
