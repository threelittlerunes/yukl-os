#!/usr/bin/env node
// GitHub VCS adapter.
//
// The adapter is the seam between the lifecycle runner and a hosting provider:
// it answers whether a pull request is safe to merge and, when it is, performs
// the merge. Every command is spawned as an argument array without a shell, so
// a ref, a base name or a trailer can never be re-interpreted by a shell.
//
// Interface (shared with the other VCS adapters):
//
//   createVcs({ gh, cwd }) -> { name, checks(ref), merge(ref, base, { runHead }) }
//     `gh` is the GitHub CLI executable, either a string ("gh") or an argv
//     prefix ([exe, ...prefixArgs]) so a test can point at a fake. `cwd` is the
//     working directory the CLI runs in.
//   checks(ref) -> { ok, results: [{ name, state }] }
//     `ok` only when the pull request has at least one required check and every
//     required check is a pass (case-insensitive "SUCCESS"/"pass"); a pending,
//     failed or empty set is not ok.
//   merge(ref, base, { runHead }) -> { ok, error? }
//     Refuses without merging unless the run-head trailer is well formed, the
//     required checks pass, and the pull request's base matches `base`. On
//     success it runs `gh pr merge` once, passing the trailer as the body.
//   runHeadTrailer({ taskId, hash }) -> "Yukl-Run-Head: <taskId> <hash>"
//     Throws when either part is missing or empty.

import { spawn } from "node:child_process";

const PASS_STATES = new Set(["success", "pass"]);

/**
 * Build the full argv for one CLI call. `gh` is a string executable or an
 * argv prefix; the call's own arguments are appended in both cases.
 */
function ghArgv(gh, args) {
  return Array.isArray(gh) ? [...gh, ...args] : [gh, ...args];
}

/** Spawn `exe` with `args` (never a shell) and resolve its captured outcome. */
function runProcess(exe, args, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn(exe, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      resolvePromise({ code: null, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function nonEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Render the run-head trailer that `merge` writes into the merge body. The
 * trailer ties a merge back to the run that produced the head, so it must
 * never be silently degraded to an empty string: a missing task id or hash
 * throws instead.
 */
export function runHeadTrailer(runHead) {
  const { taskId, hash } = runHead ?? {};
  const id = nonEmpty(taskId);
  const commit = nonEmpty(hash);
  if (id === "") throw new Error("run head trailer requires a non-empty taskId");
  if (commit === "") throw new Error("run head trailer requires a non-empty hash");
  return `Yukl-Run-Head: ${id} ${commit}`;
}

/**
 * Build a GitHub VCS adapter. See the module header for the interface.
 */
export function createVcs({ gh = "gh", cwd = process.cwd() } = {}) {
  const call = (args) => {
    const argv = ghArgv(gh, args);
    return runProcess(argv[0], argv.slice(1), cwd);
  };

  /**
   * Ask the CLI which required checks the pull request carries. The CLI exits
   * non-zero when checks are not all passing, so the exit code is ignored and
   * the JSON on stdout decides the verdict: the report is only ok when it is a
   * non-empty list whose every state is a pass.
   */
  async function checks(ref) {
    const outcome = await call(["pr", "checks", ref, "--required", "--json", "name,state"]);
    let parsed = null;
    try {
      parsed = JSON.parse(outcome.stdout);
    } catch {
      parsed = null;
    }
    const results = Array.isArray(parsed)
      ? parsed.map((entry) => ({ name: entry?.name ?? "", state: entry?.state ?? "" }))
      : [];
    const ok =
      results.length > 0 &&
      results.every((entry) => PASS_STATES.has(String(entry.state).toLowerCase()));
    return { ok, results };
  }

  /** Read the branch the pull request targets, or null when it is unreadable. */
  async function baseRef(ref) {
    const outcome = await call(["pr", "view", ref, "--json", "baseRefName"]);
    try {
      return JSON.parse(outcome.stdout)?.baseRefName ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Merge a pull request once it is proven safe: the trailer must be well
   * formed, every required check must pass and the base must match. Any
   * refusal returns before `gh pr merge` is invoked, so a rejected merge never
   * touches the remote. The only merge flags passed are `--merge` and `--body`;
   * the adapter never asks for an admin, squash, rebase or auto merge.
   */
  async function merge(ref, base, { runHead } = {}) {
    let trailer;
    try {
      trailer = runHeadTrailer(runHead);
    } catch (err) {
      return { ok: false, error: err.message };
    }

    const wanted = nonEmpty(base);
    if (wanted === "") {
      return { ok: false, error: "merge requires a non-empty base branch" };
    }

    const checksOutcome = await checks(ref);
    if (!checksOutcome.ok) {
      return { ok: false, error: `required checks for ${ref} are not all passing` };
    }

    const actualBase = await baseRef(ref);
    if (actualBase === null) {
      return { ok: false, error: `cannot read the base branch of ${ref}` };
    }
    if (actualBase !== wanted) {
      return { ok: false, error: `pull request base "${actualBase}" does not match "${wanted}"` };
    }

    const outcome = await call(["pr", "merge", ref, "--merge", "--body", trailer]);
    if (outcome.code !== 0) {
      const detail = outcome.stderr.trim() || `exit ${outcome.code}`;
      return { ok: false, error: `gh pr merge failed: ${detail}` };
    }
    return { ok: true };
  }

  return { name: "github", checks, merge };
}
