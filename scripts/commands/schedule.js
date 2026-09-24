#!/usr/bin/env node
// `yukl schedule` drives several tasks unattended, in parallel where their
// scopes allow it.
//
//   yukl schedule <task_id>... [--cwd <dir>] [--base <git-ref>]
//     [--locks-dir <dir>] [--worktrees-dir <dir>] [--json]
//
// Each task runs through `yukl run <task_id> --unattended` in its own Git
// worktree, so two tasks never share a checkout. Two tasks may run at the same
// time only when their intents' `allowed_paths` cannot overlap: a pair that
// could both touch the same file is serialised instead, because the point of
// the scheduler is to widen throughput without widening the scope in which two
// agents may write. Tasks are packed into waves in the order they are given -
// the first wave a task fits into without overlapping a task already in it, and
// a wave runs concurrently while the next one waits. A task whose intent cannot
// be read has an unknown scope, and an unknown scope overlaps everything, so
// such a task runs alone rather than racing a task it might collide with.
//
// With `--base` each task's intent is read from that ref through `git show`,
// exactly as `yukl run --base` reads its lifecycle block and policy, so a task
// branch cannot widen the scope its own scheduling is planned from; without
// `--base` the working tree is read, which makes local mode a developer preview
// rather than a trust boundary. `--base` is passed on to every task's run.
//
// Before a task runs, its id is taken as an advisory lock in `<locks-dir>` (see
// scripts/lifecycle/locks.js), so a second scheduler - or an agent that took the
// same lock by hand - cannot drive the same task twice; the lock is released
// however the task ends. Worktrees live under `<worktrees-dir>`
// (`.orchestration/worktrees/<task_id>`, git-ignored) and are reused when they
// already exist, which makes a re-run after a crash resume instead of failing.
//
// The surface is deliberately one command with positional task ids: there is no
// queue file and no daemon, so a run is exactly as reproducible as the shell
// history that started it. Exit codes: 0 when every task exited 0, 1 when a task
// failed or a lock refused it, 2 on a usage problem.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { acquireLock, isProcessAlive, releaseLock } from "../lifecycle/locks.js";
import { INTENTS_DIR } from "../yukl.js";

const YUKL_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "yukl.js");
const DEFAULT_LOCKS_DIR = ".orchestration/locks";
const DEFAULT_WORKTREES_DIR = ".orchestration/worktrees";
const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Parse the raw arguments after `schedule`. Returns `{ error }` for a usage
 * problem (the caller exits 2) or `{ taskIds, cwd, base, locksDir, worktreesDir,
 * json }`. At least one task id is required; unknown flags and duplicates are
 * refused, so a typo can never be silently ignored.
 */
function parseArgs(argv) {
  const options = { cwd: null, base: null, locksDir: null, worktreesDir: null, json: false };
  const names = {
    "--cwd": "cwd",
    "--base": "base",
    "--locks-dir": "locksDir",
    "--worktrees-dir": "worktreesDir",
  };
  const taskIds = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (Object.hasOwn(names, arg)) {
      const value = argv[++i];
      if (value === undefined) return { error: `${arg} requires a value` };
      options[names[arg]] = value;
      continue;
    }
    if (arg.startsWith("-")) return { error: `unknown option ${arg}` };
    if (!TASK_ID_RE.test(arg)) {
      return { error: `task id "${arg}" must be a lower-case path segment` };
    }
    if (taskIds.includes(arg)) return { error: `task id "${arg}" was given twice` };
    taskIds.push(arg);
  }
  if (taskIds.length === 0) return { error: "missing <task_id>" };
  return { taskIds, ...options };
}

/**
 * The directory prefix a path pattern scopes, normalised: everything up to the
 * first segment that contains a wildcard. `scripts/**` and `scripts/*.js` both
 * scope `scripts`; `docs/YUKL_ARCHITECTURE.md` scopes itself; a bare `**`
 * scopes the whole repository (the empty prefix).
 */
export function scopePrefix(pattern) {
  const normalised = String(pattern).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const segments = normalised.split("/");
  const wildcardAt = segments.findIndex((segment) => segment.includes("*"));
  const kept = wildcardAt === -1 ? segments : segments.slice(0, wildcardAt);
  return kept.join("/");
}

/** True when `inner` is `outer` or lies under it at a path boundary. */
function within(inner, outer) {
  return inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * True when two path patterns could match the same file. Deliberately
 * conservative: two prefixes overlap when either contains the other at a path
 * boundary, so `scripts/**` overlaps `scripts/lifecycle/*.js` and every
 * sibling pattern below it, while `scripts/**` and `tests/**` do not overlap.
 */
export function scopesOverlap(a, b) {
  const left = scopePrefix(a);
  const right = scopePrefix(b);
  if (left === "" || right === "") return true;
  return within(left, right) || within(right, left);
}

/**
 * True when two tasks must not run at the same time. A task whose
 * `allowedPaths` is not a non-empty array of strings has an unknown scope and
 * overlaps everything, which serialises it against every other task.
 */
export function tasksOverlap(a, b) {
  const left = Array.isArray(a?.allowedPaths) ? a.allowedPaths : null;
  const right = Array.isArray(b?.allowedPaths) ? b.allowedPaths : null;
  if (left === null || left.length === 0 || right === null || right.length === 0) return true;
  return left.some((pattern) => right.some((other) => scopesOverlap(pattern, other)));
}

/**
 * Pack `tasks` into waves, in the order given: each task joins the first wave
 * in which it overlaps no task already there, and a new wave is opened when it
 * fits none. Every wave can therefore run concurrently, and a wave never starts
 * before the previous one has settled. Pure function over the task list.
 */
export function planWaves(tasks) {
  const waves = [];
  for (const task of tasks) {
    const wave = waves.find((candidate) => candidate.every((other) => !tasksOverlap(task, other)));
    if (wave === undefined) {
      waves.push([task]);
      continue;
    }
    wave.push(task);
  }
  return waves;
}

/**
 * The `allowed_paths` of a task's intent, or null when it cannot be read or
 * carries none. A missing or malformed intent is an unknown scope rather than
 * an error: the task still runs, alone. With `base` the intent is read from
 * that ref through `git show` (argument array, no shell), so a task branch
 * cannot widen the scope its own scheduling is planned from; without `base` the
 * working tree is read, which makes local mode a developer preview rather than
 * a trust boundary.
 */
export function readIntentScope(cwd, taskId, base = null) {
  const intentRelPath = `${INTENTS_DIR}/${taskId}.yml`;
  let text;
  if (base != null) {
    const shown = spawnSync("git", ["show", `${base}:${intentRelPath}`], {
      cwd,
      encoding: "utf8",
    });
    if (shown.status !== 0) return null;
    text = shown.stdout;
  } else {
    try {
      text = readFileSync(join(cwd, intentRelPath), "utf8");
    } catch {
      return null;
    }
  }
  try {
    const doc = yaml.load(text);
    const allowed = doc?.intent?.scope?.allowed_paths;
    if (!Array.isArray(allowed) || allowed.length === 0) return null;
    if (!allowed.every((pattern) => typeof pattern === "string" && pattern !== "")) return null;
    return allowed;
  } catch {
    return null;
  }
}

/** Create (or reuse) the task's own worktree. */
function defaultCreateWorktree({ repo, path, base }) {
  if (existsSync(path)) return { ok: true, reused: true };
  mkdirSync(dirname(path), { recursive: true });
  const ref = base ?? "HEAD";
  const result = spawnSync("git", ["worktree", "add", "--detach", path, ref], {
    cwd: repo,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    return { ok: false, error: `git worktree add ${ref} failed${detail ? `: ${detail}` : ""}` };
  }
  return { ok: true, reused: false };
}

/**
 * The CLI arguments one task is driven with: the unattended loop, in the task's
 * own worktree, and the same base ref the scheduler was given (when it was).
 * Pure function, so the command surface is testable without spawning anything.
 */
export function runArguments(taskId, worktree, base = null) {
  const args = ["run", taskId, "--unattended", "--cwd", worktree];
  if (base !== null) args.push("--base", base);
  return args;
}

/** Drive one task unattended in its worktree, through the CLI. */
function defaultRunTask({ taskId, worktree, base, cwd }) {
  const result = spawnSync(
    process.execPath,
    [YUKL_SCRIPT, ...runArguments(taskId, worktree, base)],
    {
      cwd,
      encoding: "utf8",
    },
  );
  return {
    ok: result.status === 0,
    exitCode: result.status,
    error: result.status === 0 ? null : (result.stderr || "").trim() || "yukl run failed",
  };
}

/**
 * Run `yukl schedule`. Returns the process exit code. `overrides` lets a caller
 * (a test) inject the lock identity, the clock, the worktree creator and the
 * per-task runner; the defaults are the real Git and CLI.
 */
export async function run(argv = [], overrides = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`yukl schedule: ${parsed.error}`);
    return 2;
  }
  const cwd = resolve(overrides.cwd ?? parsed.cwd ?? process.cwd());
  const locksDir = resolve(overrides.locksDir ?? parsed.locksDir ?? join(cwd, DEFAULT_LOCKS_DIR));
  const worktreesDir = resolve(
    overrides.worktreesDir ?? parsed.worktreesDir ?? join(cwd, DEFAULT_WORKTREES_DIR),
  );
  const base = parsed.base ?? null;
  const pid = overrides.pid ?? process.pid;
  const host = overrides.host ?? hostname();
  const clock = overrides.clock ?? (() => new Date());
  const alive = overrides.alive ?? isProcessAlive;
  const createWorktree = overrides.createWorktree ?? defaultCreateWorktree;
  const runTask = overrides.runTask ?? defaultRunTask;

  const tasks = parsed.taskIds.map((taskId) => ({
    taskId,
    allowedPaths: overrides.scopes?.[taskId] ?? readIntentScope(cwd, taskId, base),
  }));
  const waves = planWaves(tasks);
  const results = [];

  /** Take the task's advisory lock, run it in its worktree, release the lock. */
  const driveTask = async (task) => {
    const lock = acquireLock({
      dir: locksDir,
      name: task.taskId,
      task: task.taskId,
      pid,
      host,
      clock,
      alive,
    });
    if (!lock.ok) {
      const holder = lock.holder === undefined ? lock.detail : `pid ${lock.holder.pid}`;
      return {
        taskId: task.taskId,
        ok: false,
        exitCode: null,
        error: `lock ${lock.reason} (${holder})`,
      };
    }
    try {
      const worktree = join(worktreesDir, task.taskId);
      const prepared = createWorktree({ repo: cwd, path: worktree, base });
      if (!prepared.ok) {
        return { taskId: task.taskId, ok: false, exitCode: null, error: prepared.error };
      }
      const outcome = await runTask({ taskId: task.taskId, worktree, base, cwd });
      return {
        taskId: task.taskId,
        ok: outcome.ok === true,
        exitCode: Number.isInteger(outcome.exitCode) ? outcome.exitCode : null,
        error: outcome.ok === true ? null : (outcome.error ?? "task failed"),
      };
    } finally {
      releaseLock({ dir: locksDir, name: task.taskId, pid });
    }
  };

  for (const wave of waves) {
    if (!parsed.json) {
      console.log(`schedule: wave ${wave.map((task) => task.taskId).join(" ")}`);
    }
    const settled = await Promise.all(wave.map(driveTask));
    results.push(...settled);
  }

  if (parsed.json) {
    console.log(
      JSON.stringify({
        waves: waves.map((wave) => wave.map((task) => task.taskId)),
        tasks: results,
      }),
    );
  } else {
    for (const result of results) {
      const status = result.ok ? "ok" : `failed (${result.error})`;
      console.log(`schedule: ${result.taskId} ${status}`);
    }
  }
  return results.every((result) => result.ok) ? 0 : 1;
}
