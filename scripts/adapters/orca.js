#!/usr/bin/env node
// Orca runtime adapter for the lifecycle runner (see scripts/lifecycle/runtime.js).
//
// Drives the Orca CLI through the four runtime methods. Every argument is
// passed as an element of an argument array, so no shell is ever involved and
// a spec is never re-split or globbed. The executable is injectable as a
// string ("orca") or as [exe, ...prefixArgs], which is what lets the tests run
// a Node fake on Windows and POSIX alike.
//
// The handle is the Orca dispatch id itself: `start` returns that non-empty
// string, and `status`, `result` and `stop` accept the string back. Any other
// value is a foreign handle - a handle this adapter never produced - and is
// answered without calling Orca at all: `status` reports "unverifiable",
// `result` returns null and `stop` does nothing. The lifecycle engine's
// `handleId` accepts a string or `{ id }`, so returning the bare id is the
// shape the engine records in `stage_started` and hands back on every poll.
//
// `result` maps a settled projection to an exit code rather than the outcome
// word: a `succeeded` outcome is `{ exitCode: 0 }`, a `failed` one is
// `{ exitCode: 1 }`, and anything unsettled (or unreadable) is null. The
// engine reads `result.exitCode`, so the numeric shape is what a successful
// stage is proven by.
//
// `--base-branch` is omitted from worker-start entirely when no base is known
// (null, undefined or an empty string), because Orca documents omitting the
// flag as "use the repo default base". Experiment E6 (Orca 1.4.210,
// 2026-09-25) showed that `--base-branch ""` is accepted and also falls back
// to the repository default, but that empty-string behaviour is undocumented;
// omitting the pair states the intent without depending on it.
//
// Documented limit: Orca's worker-start has no way to set the environment of
// the agent it launches, so this adapter cannot set YUKL_DISPATCH_ID on the
// worker it starts. The runtime interface asks an adapter to forward it, and
// this adapter cannot honour that clause - the `yukl decide` environment guard
// therefore does not reach Orca workers. Nothing here claims otherwise.

import { spawnSync } from "node:child_process";

const LIVE = "live";
const EXITED = "exited";
const UNVERIFIABLE = "unverifiable";

/**
 * Normalise the `orca` option into a command prefix. A string is the
 * executable itself; an array is [executable, ...leading arguments]. A fresh
 * array is returned so callers can spread it without mutating the option.
 */
function commandPrefix(orca) {
  return Array.isArray(orca) ? [...orca] : [orca];
}

/**
 * Run `prefix` followed by `args` without a shell. Returns the spawnSync
 * result, whose `status`, `stdout`, `stderr` and `error` the callers inspect.
 */
function run(prefix, args) {
  return spawnSync(prefix[0], [...prefix.slice(1), ...args], { encoding: "utf8" });
}

/**
 * Parse the JSON envelope printed by an Orca command. Returns the object, or
 * null when stdout is empty or is not a JSON object. Never throws, so a
 * malformed or truncated reply is reported by the caller as unverifiable
 * rather than crashing the lifecycle runner.
 */
function parseEnvelope(stdout) {
  try {
    const data = JSON.parse(stdout);
    return data != null && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Build an Orca runtime adapter. Options:
 *   - `orca`       executable, a string or [exe, ...prefixArgs] (default "orca")
 *   - `agent`      agent id passed to worker-start --agent
 *   - `baseBranch` ref passed to worker-start --base-branch; when it is null,
 *                  undefined or an empty string the flag pair is omitted and
 *                  Orca falls back to the repository's default base
 *   - `name`       worktree name; falls back to the start call's taskId, then
 *                  its stage id
 *
 * The returned object implements the runtime interface. The handle is the
 * dispatch id string, and `start` returns exactly that string; every method
 * accepts a non-empty string and treats any other value as a foreign handle.
 */
export function createOrcaRuntime({ orca = "orca", agent, baseBranch, name = null } = {}) {
  const prefix = commandPrefix(orca);

  /**
   * Start exactly one Orca worker and return its dispatch id as the handle. A
   * non-zero exit, an `ok: false` envelope, a missing dispatch id or an
   * unparseable reply is a failed start and is thrown; the adapter never
   * retries a failed start, so the caller can rely on exactly one Orca call
   * here.
   *
   * `--base-branch` is emitted only when a base is known: null, undefined and
   * the empty string all omit the flag pair, so Orca uses the repository's
   * default base by its documented omission rather than by passing an empty
   * value (see the module header).
   */
  function start({ stage = null, taskId = null, spec = null } = {}) {
    const workerName = name ?? taskId ?? stage;
    const baseArgs =
      baseBranch == null || baseBranch === "" ? [] : ["--base-branch", String(baseBranch)];
    const args = [
      "orchestration",
      "worker-start",
      "--spec",
      spec == null ? "" : String(spec),
      "--worktree",
      "new-top-level",
      "--name",
      workerName == null ? "" : String(workerName),
      ...baseArgs,
      "--agent",
      agent == null ? "" : String(agent),
      "--json",
    ];
    const result = run(prefix, args);
    if (result.error) {
      throw new Error(`orca worker-start could not launch: ${result.error.message}`);
    }
    const envelope = parseEnvelope(result.stdout);
    const dispatchId = envelope?.result?.dispatchId;
    if (
      result.status !== 0 ||
      envelope?.ok !== true ||
      typeof dispatchId !== "string" ||
      dispatchId === ""
    ) {
      const detail = (result.stderr || "").trim() || (result.stdout || "").trim();
      throw new Error(`orca worker-start failed (exit ${result.status}): ${detail}`);
    }
    return dispatchId;
  }

  /**
   * Map the worker's liveness verdict strictly. Only the literal "live" and
   * "exited" verdicts are reported; a non-zero exit, an `ok: false` envelope,
   * unparseable JSON, a missing field or any other value is unverifiable.
   * "exited" is never reported without the literal verdict. A handle that is
   * not a non-empty string is foreign and is reported unverifiable without
   * calling Orca.
   */
  function status(handle) {
    if (typeof handle !== "string" || handle === "") return UNVERIFIABLE;
    const result = run(prefix, ["orchestration", "worker-show", "--dispatch", handle, "--json"]);
    if (result.status !== 0) return UNVERIFIABLE;
    const envelope = parseEnvelope(result.stdout);
    if (envelope?.ok !== true) return UNVERIFIABLE;
    const verdict = envelope?.result?.projection?.liveness?.verdict;
    if (verdict === LIVE) return LIVE;
    if (verdict === EXITED) return EXITED;
    return UNVERIFIABLE;
  }

  /**
   * Read the settled terminal outcome as an exit code, so the engine's
   * `result.exitCode === 0` success check can read it. A `succeeded`
   * projection is `{ exitCode: 0 }`, a `failed` one is `{ exitCode: 1 }`;
   * anything else (an unsettled outcome, an unparseable reply, a non-zero
   * exit or a foreign handle) means not settled yet and yields null.
   */
  function result(handle) {
    if (typeof handle !== "string" || handle === "") return null;
    const shown = run(prefix, ["orchestration", "worker-show", "--dispatch", handle, "--json"]);
    if (shown.status !== 0) return null;
    const envelope = parseEnvelope(shown.stdout);
    if (envelope?.ok !== true) return null;
    const outcome = envelope?.result?.projection?.outcome;
    if (outcome === "succeeded") return { exitCode: 0 };
    if (outcome === "failed") return { exitCode: 1 };
    return null;
  }

  /**
   * Fence and stop the worker. A foreign handle - anything that is not a
   * non-empty string - is ignored without calling Orca. The reply is not
   * inspected: one already-exited worker is as good as a stopped one.
   */
  function stop(handle) {
    if (typeof handle !== "string" || handle === "") return;
    run(prefix, ["orchestration", "worker-stop", "--dispatch", handle, "--json"]);
  }

  return { start, status, result, stop };
}
