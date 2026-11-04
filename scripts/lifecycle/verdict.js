// Audit verdicts (cloud-y2-audit-verdict).
//
// An audit stage passes on the verdict its auditor committed, not on the
// auditor's exit code: an auditor that writes FAIL and exits 0 must not count
// as a pass. The verdict is the file `.orchestration/verdicts/<task_id>.json`,
// read at the commit named by the audit stage's resolved anchor through
// `git show <commit>:<path>`, never from the working tree, so an uncommitted
// or later edit cannot change what was judged.
//
// The only valid shape is an object whose `verdict` is "pass" or "fail" (lower
// case) and whose `reasons` is an array of strings. Anything else - a missing
// file, an unreadable commit, invalid JSON, an extra spelling - is malformed,
// and the reader reports it as not ok, so the engine blocks the stage instead
// of passing it (fail closed).
//
// git is invoked with an argument array, never a shell string, and the task id
// and commit are checked before git runs, so a crafted value cannot name a path
// outside the verdicts folder or smuggle in a flag.
import { spawnSync } from "node:child_process";

/** The folder audit verdicts are committed to. */
export const VERDICTS_DIR = ".orchestration/verdicts";

/** The two verdicts an auditor can record. */
export const VERDICTS = Object.freeze({ PASS: "pass", FAIL: "fail" });

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT_RE = /^[0-9a-f]{40}$/i;

/** The repository-relative verdict path for `taskId`, or null for an unsafe id. */
export function verdictPath(taskId) {
  if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId) || taskId.includes("..")) {
    return null;
  }
  return `${VERDICTS_DIR}/${taskId}.json`;
}

/**
 * Validate a parsed verdict document. Returns `{ ok: true, verdict, reasons }`
 * for `{ verdict: "pass" | "fail", reasons: string[] }` and
 * `{ ok: false, error }` for any other shape. Extra keys are refused, so a
 * verdict cannot carry a second, conflicting judgement.
 */
export function verdictViolation(doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: "a verdict must be a JSON object" };
  }
  const extra = Object.keys(doc).filter((key) => key !== "verdict" && key !== "reasons");
  if (extra.length > 0) {
    return { ok: false, error: `unknown verdict keys: ${extra.join(", ")}` };
  }
  if (doc.verdict !== VERDICTS.PASS && doc.verdict !== VERDICTS.FAIL) {
    return { ok: false, error: 'verdict must be "pass" or "fail" (lower case)' };
  }
  if (!Array.isArray(doc.reasons) || !doc.reasons.every((reason) => typeof reason === "string")) {
    return { ok: false, error: "reasons must be an array of strings" };
  }
  return { ok: true, verdict: doc.verdict, reasons: [...doc.reasons] };
}

/** Parse verdict text. Returns the `verdictViolation` result, or a parse error. */
export function parseVerdict(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `cannot parse the verdict as JSON: ${err.message}` };
  }
  return verdictViolation(doc);
}

/**
 * Read the verdict for `taskId` at `commit` in the repository at `cwd`.
 * Returns `{ ok: true, verdict, reasons, path, commit }` or `{ ok: false, error }`.
 * A missing file and an unknown commit are both not ok.
 */
export function readVerdictAt({ cwd, taskId, commit } = {}) {
  const path = verdictPath(taskId);
  if (path === null) return { ok: false, error: `unsafe task id for a verdict: ${taskId}` };
  if (typeof commit !== "string" || !COMMIT_RE.test(commit)) {
    return { ok: false, error: `the audit anchor names no commit: ${commit}` };
  }
  const shown = spawnSync("git", ["show", `${commit}:${path}`], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (shown.error) return { ok: false, error: `git show failed: ${shown.error.message}` };
  if (shown.status !== 0) {
    return { ok: false, error: `no verdict ${path} at ${commit}` };
  }
  const parsed = parseVerdict(shown.stdout ?? "");
  if (!parsed.ok) return { ok: false, error: `${path} at ${commit}: ${parsed.error}` };
  return { ...parsed, path, commit };
}
