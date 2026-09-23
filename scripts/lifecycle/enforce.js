// Run-time path enforcement for a task branch (v2-w1).
//
// A thin wrapper over the deterministic core in scripts/yukl.js: list the
// files a branch changes since a base ref, resolve the task's intent at that
// base ref and delegate the per-file decision to the core matcher. No path
// matching logic lives here; the wrapper only wires git, the intent resolver
// and checkIntentPaths together so a caller can ask one question: does this
// branch stay inside the paths its intent allows?

import { spawnSync } from "node:child_process";
import { checkIntentPaths, resolveIntentForContract } from "../yukl.js";

export const PATH_SCOPE_RULE = "R-PATH-SCOPE";

/**
 * The repo-relative paths `branch` changes since its merge base with `base`,
 * via `git diff --name-only <base>...<branch>`. The argument array is passed
 * to git directly (no shell), so a ref carrying shell metacharacters is
 * treated as a literal revision. Returns { ok: true, files } or
 * { ok: false, error }.
 */
function changedFiles(base, branch, cwd) {
  const result = spawnSync("git", ["diff", "--name-only", `${base}...${branch}`], {
    cwd,
    encoding: "utf8",
  });
  if (result.error) {
    return { ok: false, error: `git diff failed: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: `git diff ${base}...${branch} failed: ${(result.stderr || "").trim()}`,
    };
  }
  return { ok: true, files: result.stdout.split(/\r?\n/).filter(Boolean) };
}

/**
 * Enforce the intent's path scope against everything `branch` changes since
 * `base`. `base` is the trust root: the intent is read from that ref, never
 * from the branch, so a branch cannot widen its own scope and an intent that
 * exists only on the branch does not resolve. Contract files are exempt (the
 * core skips them). Returns { ok, violations, rule: "R-PATH-SCOPE" }, where
 * `ok` is true only when every changed file satisfies the intent.
 */
export function pathEnforcement({ cwd = process.cwd(), base, taskId, branch } = {}) {
  const rule = PATH_SCOPE_RULE;
  if (base == null || base === "" || branch == null || branch === "") {
    return { ok: false, violations: ["base and branch are required"], rule };
  }

  const diff = changedFiles(base, branch, cwd);
  if (!diff.ok) {
    return { ok: false, violations: [diff.error], rule };
  }

  const resolution = resolveIntentForContract({ taskId, base, cwd });
  if (!resolution.ok) {
    return { ok: false, violations: [resolution.error], rule };
  }

  const violations = checkIntentPaths(diff.files, resolution.doc);
  return { ok: violations.length === 0, violations, rule };
}
