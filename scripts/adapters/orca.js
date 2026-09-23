#!/usr/bin/env node
// Orca runtime adapter for the lifecycle runner (see scripts/lifecycle/runtime.js).
//
// Drives the Orca CLI through the four runtime methods. Every argument is
// passed as an element of an argument array, so no shell is ever involved and
// a spec is never re-split or globbed. The executable is injectable as a
// string ("orca") or as [exe, ...prefixArgs], which is what lets the tests run
// a Node fake on Windows and POSIX alike.
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
 *   - `baseBranch` ref passed to worker-start --base-branch
 *   - `name`       worktree name; falls back to the start call's taskId, then
 *                  its stage id
 *
 * The returned object implements the runtime interface. The handle is
 * `{ dispatchId }` and is the only shape this adapter ever accepts back.
 */
export function createOrcaRuntime({ orca = "orca", agent, baseBranch, name = null } = {}) {
  const prefix = commandPrefix(orca);

  /**
   * Start exactly one Orca worker and return its handle. A non-zero exit, an
   * `ok: false` envelope, a missing dispatch id or an unparseable reply is a
   * failed start and is thrown; the adapter never retries a failed start, so
   * the caller can rely on exactly one Orca call here.
   */
  function start({ stage = null, taskId = null, spec = null } = {}) {
    const workerName = name ?? taskId ?? stage;
    const args = [
      "orchestration",
      "worker-start",
      "--spec",
      spec == null ? "" : String(spec),
      "--worktree",
      "new-top-level",
      "--name",
      workerName == null ? "" : String(workerName),
      "--base-branch",
      baseBranch == null ? "" : String(baseBranch),
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
    return { dispatchId };
  }

  /**
   * Map the worker's liveness verdict strictly. Only the literal "live" and
   * "exited" verdicts are reported; a non-zero exit, an `ok: false` envelope,
   * unparseable JSON, a missing field or any other value is unverifiable.
   * "exited" is never reported without the literal verdict.
   */
  function status(handle) {
    const dispatchId = handle?.dispatchId;
    if (typeof dispatchId !== "string" || dispatchId === "") return UNVERIFIABLE;
    const result = run(prefix, [
      "orchestration",
      "worker-show",
      "--dispatch",
      dispatchId,
      "--json",
    ]);
    if (result.status !== 0) return UNVERIFIABLE;
    const envelope = parseEnvelope(result.stdout);
    if (envelope?.ok !== true) return UNVERIFIABLE;
    const verdict = envelope?.result?.projection?.liveness?.verdict;
    if (verdict === LIVE) return LIVE;
    if (verdict === EXITED) return EXITED;
    return UNVERIFIABLE;
  }

  /**
   * Read the settled terminal outcome. Returns "succeeded" or "failed" once
   * the projection is settled; anything else (including an unparseable reply,
   * a non-zero exit or a foreign handle) means not settled yet and yields null.
   */
  function result(handle) {
    const dispatchId = handle?.dispatchId;
    if (typeof dispatchId !== "string" || dispatchId === "") return null;
    const shown = run(prefix, ["orchestration", "worker-show", "--dispatch", dispatchId, "--json"]);
    if (shown.status !== 0) return null;
    const envelope = parseEnvelope(shown.stdout);
    if (envelope?.ok !== true) return null;
    const outcome = envelope?.result?.projection?.outcome;
    return outcome === "succeeded" || outcome === "failed" ? outcome : null;
  }

  /**
   * Fence and stop the worker. A foreign handle is ignored. The reply is not
   * inspected: one already-exited worker is as good as a stopped one.
   */
  function stop(handle) {
    const dispatchId = handle?.dispatchId;
    if (typeof dispatchId !== "string" || dispatchId === "") return;
    run(prefix, ["orchestration", "worker-stop", "--dispatch", dispatchId, "--json"]);
  }

  return { start, status, result, stop };
}
