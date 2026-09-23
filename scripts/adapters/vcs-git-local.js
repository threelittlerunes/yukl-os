#!/usr/bin/env node
// A local git VCS adapter.
//
// This adapter is the seam between the harness and a local, non-bare working
// repository. It proves a ref by running the repository's proof commands in a
// throwaway worktree and merges a ref into a base branch only when those
// commands pass and the caller supplies a complete run head. It never rebases,
// never forces and never resets: the base branch moves only by an ordinary
// merge commit whose message ends in the run-head trailer.
//
// Interface (shared with the remote adapter):
//
//   createVcs({ repoDir, commands, base }) -> { name, checks, merge }
//     `repoDir` is a local non-bare working repository. `commands` is the
//     allowlisted proof command list; when omitted it is resolved from
//     yukl.config.json at `base` (default "main") so a caller that does not
//     hold the allowlist cannot widen it.
//   checks(ref) -> { ok, results: [{ command, exitCode }] }
//     Checks `ref` out in a temporary worktree, runs every proof command
//     there with a shell and reports each exit code. `ok` is true only when
//     every exit code is 0.
//   merge(ref, base, { runHead }) -> { ok, sha?, error? }
//     Refuses, changing nothing, when `runHead` is incomplete or `checks(ref)`
//     is not ok. Otherwise merges `ref` into `base` with `git merge --no-ff`
//     in a temporary worktree and moves the base branch ref to the merge
//     commit, whose message ends in the run-head trailer.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGateConfig } from "../yukl.js";

const DEFAULT_BASE = "main";

/**
 * Render the run-head trailer for a dispatch. Throws when either part is
 * missing or empty, so an incomplete run head can never be committed.
 */
export function runHeadTrailer(runHead) {
  const { taskId, hash } = runHead ?? {};
  if (
    typeof taskId !== "string" ||
    taskId.trim() === "" ||
    typeof hash !== "string" ||
    hash.trim() === ""
  ) {
    throw new Error("run head requires a non-empty taskId and hash");
  }
  return `Yukl-Run-Head: ${taskId} ${hash}`;
}

function runGit(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

/** Full ref name for a base that is a branch name or already a full ref. */
function branchRef(base) {
  return base.startsWith("refs/") ? base : `refs/heads/${base}`;
}

/** Remove a temporary git worktree and its parent directory, ignoring errors. */
function removeTempWorktree(worktree, tempRoot, repoDir) {
  runGit(["worktree", "remove", "--force", worktree], repoDir);
  rmSync(tempRoot, { recursive: true, force: true });
}

/**
 * Build a local git VCS adapter. See the file header for the interface.
 */
export function createVcs({ repoDir, commands = null, base = DEFAULT_BASE } = {}) {
  if (typeof repoDir !== "string" || repoDir.trim() === "") {
    throw new Error("repoDir must be a non-empty path");
  }
  let allowlist = commands;
  if (allowlist == null) {
    const resolved = resolveGateConfig({ base, cwd: repoDir });
    if (!resolved.ok) {
      throw new Error(`cannot resolve proof commands at ${base}: ${resolved.error}`);
    }
    allowlist = resolved.allowlist;
  }
  if (!Array.isArray(allowlist) || !allowlist.every((c) => typeof c === "string" && c !== "")) {
    throw new Error("commands must be an array of non-empty strings");
  }

  async function checks(ref) {
    const tempRoot = mkdtempSync(join(tmpdir(), "yukl-vcs-"));
    const worktree = join(tempRoot, "checkout");
    try {
      const add = runGit(["worktree", "add", "--detach", worktree, ref], repoDir);
      if (add.status !== 0) {
        return {
          ok: false,
          results: [],
          error: `cannot check out ${ref}: ${(add.stderr || "").trim()}`,
        };
      }
      const results = allowlist.map((command) => {
        const run = spawnSync(command, { shell: true, cwd: worktree, stdio: "ignore" });
        const exitCode = typeof run.status === "number" ? run.status : 1;
        return { command, exitCode };
      });
      return { ok: results.every((r) => r.exitCode === 0), results };
    } finally {
      removeTempWorktree(worktree, tempRoot, repoDir);
      runGit(["worktree", "prune"], repoDir);
    }
  }

  async function merge(ref, baseRef, { runHead } = {}) {
    let trailer;
    try {
      trailer = runHeadTrailer(runHead);
    } catch (err) {
      return { ok: false, error: err.message };
    }

    const outcome = await checks(ref);
    if (!outcome.ok) {
      return { ok: false, error: `refusing to merge ${ref}: proof checks did not pass` };
    }

    const fullRef = branchRef(baseRef);
    const before = runGit(["rev-parse", "--verify", fullRef], repoDir);
    if (before.status !== 0) {
      return { ok: false, error: `base ${baseRef} does not resolve` };
    }
    const oldSha = before.stdout.trim();

    const tempRoot = mkdtempSync(join(tmpdir(), "yukl-vcs-"));
    const worktree = join(tempRoot, "checkout");
    try {
      const add = runGit(["worktree", "add", "--detach", worktree, oldSha], repoDir);
      if (add.status !== 0) {
        return {
          ok: false,
          error: `cannot check out base ${baseRef}: ${(add.stderr || "").trim()}`,
        };
      }
      const message = `Merge ${ref} into ${baseRef}\n\n${trailer}`;
      const merged = runGit(["merge", "--no-ff", ref, "-m", message], worktree);
      if (merged.status !== 0) {
        runGit(["merge", "--abort"], worktree);
        const detail = (merged.stderr || merged.stdout || "").trim();
        return { ok: false, error: `merge of ${ref} into ${baseRef} failed: ${detail}` };
      }
      const head = runGit(["rev-parse", "HEAD"], worktree);
      const newSha = head.stdout.trim();
      const updated = runGit(["update-ref", fullRef, newSha, oldSha], repoDir);
      if (updated.status !== 0) {
        return { ok: false, error: `cannot update ${baseRef}: ${(updated.stderr || "").trim()}` };
      }
      return { ok: true, sha: newSha };
    } finally {
      removeTempWorktree(worktree, tempRoot, repoDir);
      runGit(["worktree", "prune"], repoDir);
    }
  }

  return { name: "vcs-git-local", checks, merge };
}
