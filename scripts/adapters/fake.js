#!/usr/bin/env node
// A scripted fake runtime adapter for tests.
//
// The fake never touches a real agent: `start` replays one step from the
// scripted list, so a test can drive a deterministic sequence of outcomes
// (files written in the worktree, an optional commit, an exit code) without a
// process, a network or a clock. It records the environment each start was
// given and counts starts, which is enough to prove that the runtime seam
// forwards `YUKL_DISPATCH_ID` and that a caller starts an agent exactly once.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const GIT_IDENTITY = ["-c", "user.email=yukl-fake@example.invalid", "-c", "user.name=Yukl Fake"];

function writeFiles(worktree, files) {
  const written = [];
  for (const [relPath, content] of Object.entries(files ?? {})) {
    const absPath = join(worktree, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content);
    written.push(relPath);
  }
  return written;
}

function commitWorktree(worktree, message) {
  const add = spawnSync("git", ["add", "-A"], { cwd: worktree, encoding: "utf8" });
  if (add.status !== 0) throw new Error(`fake runtime could not stage the worktree: ${add.stderr}`);
  const commit = spawnSync("git", [...GIT_IDENTITY, "commit", "-m", message], {
    cwd: worktree,
    encoding: "utf8",
  });
  if (commit.status !== 0) throw new Error(`fake runtime could not commit: ${commit.stderr}`);
}

/**
 * Build a fake runtime that replays `script`, one step per call to `start`.
 *
 * A step is `{ files?, commit?, exitCode? }`:
 *   - `files`    mapping of worktree-relative path to content, written on start
 *   - `commit`   true, or a commit message, to commit the worktree after writing
 *   - `exitCode` the code the agent "exits" with; omit it to stay live
 *
 * The returned object implements the runtime interface. `startCount` counts
 * starts and `starts` is the list of recorded handles, each carrying the `env`
 * the caller passed, so a test can read back `YUKL_DISPATCH_ID`.
 */
export function createFakeRuntime({ script = [] } = {}) {
  const steps = Array.isArray(script) ? script : [];
  let startCount = 0;
  const handles = new Map();
  const starts = [];

  function start({
    stage = null,
    taskId = null,
    spec = null,
    worktree = process.cwd(),
    env = {},
  } = {}) {
    const step = steps[startCount] ?? {};
    startCount += 1;
    const id = `fake-${startCount}`;
    const files = writeFiles(worktree, step.files);
    let commit = null;
    if (step.commit) {
      commit = typeof step.commit === "string" ? step.commit : "fake runtime commit";
      commitWorktree(worktree, commit);
    }
    const exitCode = typeof step.exitCode === "number" ? step.exitCode : null;
    const handle = {
      id,
      stage,
      taskId,
      spec,
      worktree,
      env,
      exitCode,
      commit,
      files,
      status: exitCode === null ? "live" : "exited",
    };
    handles.set(id, handle);
    starts.push(handle);
    return handle;
  }

  function status(handle) {
    return handles.get(handle?.id)?.status ?? "unverifiable";
  }

  function result(handle) {
    const recorded = handles.get(handle?.id);
    if (!recorded) return null;
    return {
      exitCode: recorded.exitCode,
      files: [...recorded.files],
      commit: recorded.commit,
      env: recorded.env,
      stage: recorded.stage,
      taskId: recorded.taskId,
    };
  }

  function stop(handle) {
    const recorded = handles.get(handle?.id);
    if (recorded) recorded.status = "exited";
  }

  return {
    start,
    status,
    result,
    stop,
    get startCount() {
      return startCount;
    },
    get starts() {
      return starts;
    },
  };
}
