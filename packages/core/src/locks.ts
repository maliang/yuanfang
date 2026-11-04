import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { FileLockInfo } from "@yuanfang/shared";

interface Waiter {
  owner: string;
  projectId: string | null;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

interface LockState {
  owner: string;
  projectId: string | null;
  acquiredAt: number;
  depth: number;
  release: () => void;
  queue: Waiter[];
}

export interface AcquireOptions {
  owner: string;
  projectId?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Default true: the same owner may acquire a path it already holds. */
  reentrant?: boolean;
}

/**
 * Cross-agent, in-process file lock. Every `edit`/`write` acquires the canonical
 * path before touching it, so two agents can never modify one file at once.
 * Locks are released on tool completion, failure, or abort.
 */
export class FileLockManager {
  readonly #locks = new Map<string, LockState>();
  readonly #listeners = new Set<(locks: FileLockInfo[]) => void>();
  readonly #cwd: () => string;
  readonly #now: () => number;

  constructor(cwd: () => string, now: () => number = Date.now) {
    this.#cwd = cwd;
    this.#now = now;
  }

  subscribe(listener: (locks: FileLockInfo[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshot(): FileLockInfo[] {
    return [...this.#locks.entries()].map(([path, state]) => ({
      path,
      owner: state.owner,
      projectId: state.projectId,
      acquiredAt: state.acquiredAt,
    }));
  }

  async canonical(path: string): Promise<string> {
    const absolute = isAbsolute(path) ? path : resolve(this.#cwd(), path);
    try {
      return await realpath(absolute);
    } catch {
      try {
        return resolve(await realpath(dirname(absolute)), absolute.split("/").at(-1) ?? "");
      } catch {
        return absolute;
      }
    }
  }

  /**
   * Acquire every path in a stable order, returning a release function.
   * Paths are canonicalized first, so `./a.ts` and `/work/a.ts` share one lock.
   */
  async acquire(paths: readonly string[], options: AcquireOptions): Promise<() => void> {
    const canonical = [...new Set(await Promise.all(paths.map((path) => this.canonical(path))))].sort();
    const releases: Array<() => void> = [];
    try {
      for (const path of canonical) {
        releases.push(await this.#acquireOne(path, options));
      }
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of releases.reverse()) release();
      this.#emit();
    };
  }

  #acquireOne(path: string, options: AcquireOptions): Promise<() => void> {
    if (options.signal?.aborted === true) {
      return Promise.reject(options.signal.reason ?? new Error("aborted"));
    }
    const existing = this.#locks.get(path);
    if (existing === undefined) {
      const state: LockState = {
        owner: options.owner,
        projectId: options.projectId ?? null,
        acquiredAt: this.#now(),
        depth: 1,
        release: () => this.#releaseForOwner(path, options.owner),
        queue: [],
      };
      this.#locks.set(path, state);
      this.#emit();
      return Promise.resolve(state.release);
    }

    if (options.reentrant !== false && existing.owner === options.owner) {
      existing.depth += 1;
      return Promise.resolve(() => this.#releaseForOwner(path, options.owner));
    }

    return new Promise<() => void>((resolvePromise, reject) => {
      const waiter: Waiter = {
        owner: options.owner,
        projectId: options.projectId ?? null,
        resolve: resolvePromise,
        reject,
        signal: options.signal,
        onAbort: undefined,
      };
      if (options.signal !== undefined) {
        waiter.onAbort = () => {
          const state = this.#locks.get(path);
          if (state === undefined) return;
          const index = state.queue.indexOf(waiter);
          if (index >= 0) state.queue.splice(index, 1);
          reject(options.signal?.reason ?? new Error("aborted"));
        };
        options.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      existing.queue.push(waiter);
      this.#emit();
    });
  }

  #releaseForOwner(path: string, owner: string): void {
    const state = this.#locks.get(path);
    if (state === undefined || state.owner !== owner) return;
    if (state.depth > 1) {
      state.depth -= 1;
      this.#emit();
      return;
    }
    this.#release(path);
  }

  #release(path: string): void {
    const state = this.#locks.get(path);
    if (state === undefined) return;
    // The next waiter inherits the lock and keeps it until its own release.
    for (;;) {
      const next = state.queue.shift();
      if (next === undefined) {
        this.#locks.delete(path);
        this.#emit();
        return;
      }
      if (next.signal?.aborted === true) {
        next.reject(next.signal.reason ?? new Error("aborted"));
        continue;
      }
      if (next.onAbort !== undefined) next.signal?.removeEventListener("abort", next.onAbort);
      state.owner = next.owner;
      state.projectId = next.projectId;
      state.acquiredAt = this.#now();
      state.depth = 1;
      state.release = () => this.#releaseForOwner(path, next.owner);
      next.resolve(state.release);
      this.#emit();
      return;
    }
  }

  #emit(): void {
    const locks = this.snapshot();
    for (const listener of this.#listeners) {
      try {
        listener(locks);
      } catch {
        // A broken listener must not break a file mutation.
      }
    }
  }
}
