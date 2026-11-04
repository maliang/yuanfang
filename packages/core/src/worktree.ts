import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TaskWorktree {
  path: string;
  branch: string;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

export async function gitCommitInitial(root: string): Promise<void> {
  try {
    await git(root, ["add", "-A"]);
    await execFileAsync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=元芳",
        "-c",
        "user.email=yuanfang@local",
        "commit",
        "-m",
        "chore: initial commit",
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
  } catch {
    // No changes, missing git identity config, or not a repo: worktree mode will
    // simply fall back to the main working tree.
  }
}

/**
 * Create an isolated worktree from HEAD for one task. Returns undefined when
 * the project is not a clean git work tree with at least one commit; callers
 * then fall back to the main working tree and file claims.
 */
export async function createTaskWorktree(input: {
  projectPath: string;
  workspace: string;
  projectId: string;
  taskId: string;
}): Promise<TaskWorktree | undefined> {
  try {
    const top = await git(input.projectPath, ["rev-parse", "--show-toplevel"]);
    const realTop = await git(input.projectPath, ["rev-parse", "--show-toplevel"]);
    if (realTop !== top) return undefined;
    await git(input.projectPath, ["rev-parse", "--verify", "HEAD"]);
    const status = await git(input.projectPath, ["status", "--porcelain"]);
    if (status.length > 0) return undefined;
  } catch {
    return undefined;
  }

  const branch = `yuanfang/task-${input.taskId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(-48)}`;
  const path = join(input.workspace, "worktrees", input.projectId, input.taskId);
  await mkdir(join(input.workspace, "worktrees", input.projectId), { recursive: true });
  try {
    await git(input.projectPath, ["worktree", "remove", "--force", path]);
  } catch {
    // No stale worktree.
  }
  try {
    await git(input.projectPath, ["branch", "-D", branch]);
  } catch {
    // No stale branch.
  }
  try {
    await git(input.projectPath, ["worktree", "add", "-b", branch, path, "HEAD"]);
    return { path, branch };
  } catch {
    return undefined;
  }
}

export async function mergeIntoProject(
  projectPath: string,
  branch: string,
  message: string,
): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
  try {
    await git(projectPath, ["merge", "--no-ff", branch, "-m", message]);
    return { ok: true };
  } catch {
    let conflicts: string[] = [];
    try {
      conflicts = (await git(projectPath, ["diff", "--name-only", "--diff-filter=U"]))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      // Ignore.
    }
    try {
      await git(projectPath, ["merge", "--abort"]);
    } catch {
      // Ignore.
    }
    return { ok: false, conflicts };
  }
}

/** Merge a task branch inside a temporary worktree; conflicted files stay for an agent to resolve. */
export async function mergeInsideWorktree(
  worktree: TaskWorktree,
  branch: string,
): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
  try {
    await git(worktree.path, ["merge", "--no-ff", branch, "-m", `yuanfang: merge ${branch}`]);
    return { ok: true };
  } catch {
    try {
      const conflicts = (await git(worktree.path, ["diff", "--name-only", "--diff-filter=U"]))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return { ok: false, conflicts };
    } catch {
      return { ok: false, conflicts: [] };
    }
  }
}

export async function currentHead(projectPath: string): Promise<string> {
  return git(projectPath, ["rev-parse", "HEAD"]);
}

export async function unmergedPaths(worktree: TaskWorktree): Promise<string[]> {
  try {
    return (await git(worktree.path, ["diff", "--name-only", "--diff-filter=U"]))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export async function conflictMarkerPaths(worktree: TaskWorktree, paths: string[]): Promise<string[]> {
  const marked: string[] = [];
  for (const path of paths) {
    try {
      const text = await readFile(join(worktree.path, path), "utf8");
      if (/^<<<<<<< /m.test(text) || (/^=======$/m.test(text) && /^>>>>>>> /m.test(text))) marked.push(path);
    } catch {
      // Deleted/renamed file.
    }
  }
  return marked;
}

export async function commitAll(worktree: TaskWorktree, message: string): Promise<void> {
  await git(worktree.path, ["add", "-A"]);
  try {
    await execFileAsync(
      "git",
      [
        "-C",
        worktree.path,
        "-c",
        "user.name=元芳",
        "-c",
        "user.email=yuanfang@local",
        "commit",
        "-m",
        message,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
  } catch {
    // No changes.
  }
}

/** Commit all changes made inside a task worktree before accepting it. */
export async function commitTaskWorktree(worktree: TaskWorktree, message: string): Promise<void> {
  await git(worktree.path, ["add", "-A"]);
  try {
    await execFileAsync(
      "git",
      [
        "-C",
        worktree.path,
        "-c",
        "user.name=元芳",
        "-c",
        "user.email=yuanfang@local",
        "commit",
        "-m",
        message,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
  } catch {
    // Nothing changed; the branch still points at its base and merge is a no-op.
  }
}

/** Merge a task branch into the project branch. Throws on conflicts. */
export async function mergeTaskWorktree(
  projectPath: string,
  worktree: TaskWorktree,
  message: string,
): Promise<void> {
  try {
    await git(projectPath, ["merge", "--no-ff", worktree.branch, "-m", message]);
  } catch (error) {
    try {
      await git(projectPath, ["merge", "--abort"]);
    } catch {
      // Nothing to abort.
    }
    throw new Error(
      `合并 worktree 失败，可能有冲突，请在项目里手动解决：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function removeTaskWorktree(projectPath: string, worktree: TaskWorktree): Promise<void> {
  try {
    await git(projectPath, ["worktree", "remove", "--force", worktree.path]);
  } catch {
    // Already removed.
  }
  try {
    await git(projectPath, ["branch", "-D", worktree.branch]);
  } catch {
    // Branch may have been merged and deleted, or never created.
  }
}

export async function gitDiffStat(projectPath: string): Promise<string> {
  try {
    return await git(projectPath, ["diff", "--stat", "HEAD"]);
  } catch {
    return "";
  }
}
