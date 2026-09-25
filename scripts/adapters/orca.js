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
// A failed start is never silent. `worker-start` exits 0 only for a ready
// worker; a failed or outcome_unknown call exits 1 and may still have created
// the worker, naming it as `result.dispatchId` or among the `residualResources`
// it reports. When the reply names an id, the adapter stops it through
// `worker-stop` before throwing, and the error names the id and the
// `residualResources`. The stop is checked, not assumed: when `worker-stop`
// cannot be proven to have stopped that worker - a spawn error, a non-zero
// exit, `ok: false` or an unparseable reply - the thrown error says the worker
// "may still be running" and carries `startOutcomeUnknown = true`, which the
// engine turns into a `stage_start_unknown` block rather than a diagnosed
// failure (see scripts/lifecycle/engine.js). Only a proven stop is reported as
// one, so a failed start never claims a live worker was stopped. A start with
// no spec, no configured agent or no derivable
// worker name is refused before any Orca command runs: an empty `--spec`,
// `--name` or `--agent` value is never passed.
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
 * The first non-empty string id an entry of `residualResources` names, or null.
 * Orca may report a leftover as a bare id or as an object describing it.
 */
function residualEntryId(entry) {
  if (typeof entry === "string" && entry !== "") return entry;
  if (entry === null || typeof entry !== "object") return null;
  for (const key of ["dispatchId", "id"]) {
    const value = entry[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/**
 * The dispatch id a failed worker-start reply still names, or null. A failed or
 * outcome_unknown call may already have created the worker and reports it
 * either as `result.dispatchId` or among the `result.residualResources` it left
 * behind. A reply that names none yields null, so the adapter stops nothing it
 * cannot identify.
 */
function residualDispatchId(envelope) {
  const result = envelope?.result;
  if (result === null || typeof result !== "object") return null;
  if (typeof result.dispatchId === "string" && result.dispatchId !== "") return result.dispatchId;
  const residual = Array.isArray(result.residualResources) ? result.residualResources : [];
  for (const entry of residual) {
    const id = residualEntryId(entry);
    if (id !== null) return id;
  }
  return null;
}

/**
 * The error a failed worker-start throws: the exit code, the dispatch id this
 * adapter stopped when the reply named one, Orca's `residualResources` when it
 * reported any, and the reply's detail. `stopFailure` is the reason the stop of
 * `stoppedId` could not be proven, or null when it was: a stop that failed is
 * reported as such and never as a bare "stopped".
 */
function startFailureMessage({ status, stoppedId, stopFailure = null, envelope, detail }) {
  const parts = [`orca worker-start failed (exit ${status})`];
  if (stoppedId !== null) {
    parts.push(
      stopFailure === null
        ? `stopped residual worker ${stoppedId}`
        : `worker-stop failed for residual worker ${stoppedId} (${stopFailure}); it may still be running`,
    );
  }
  const residual = envelope?.result?.residualResources;
  if (Array.isArray(residual) && residual.length > 0) {
    parts.push(`residualResources ${JSON.stringify(residual)}`);
  }
  return `${parts.join("; ")}: ${detail}`;
}

/**
 * Build an Orca runtime adapter. Options:
 *   - `orca`       executable, a string or [exe, ...prefixArgs] (default "orca")
 *   - `agent`      agent id passed to worker-start --agent; required and
 *                  non-empty, because an empty --agent asks Orca to choose
 *   - `baseBranch` ref passed to worker-start --base-branch; when it is null,
 *                  undefined or an empty string the flag pair is omitted and
 *                  Orca falls back to the repository's default base
 *   - `name`       worktree name; falls back to the start call's taskId, then
 *                  its stage id, and a start that can derive none is refused
 *
 * The returned object implements the runtime interface. The handle is the
 * dispatch id string, and `start` returns exactly that string; every method
 * accepts a non-empty string and treats any other value as a foreign handle.
 */
export function createOrcaRuntime({ orca = "orca", agent, baseBranch, name = null } = {}) {
  const prefix = commandPrefix(orca);

  /**
   * Stop a residual worker through `worker-stop`, and report why that could not
   * be proven - or null when it was. A stop succeeded only when the process
   * exited 0 and the reply is a JSON object that does not say `ok: false`: a
   * spawn error, a non-zero exit, `ok: false` and an unparseable reply are each
   * reported as a reason, so `start` never claims a worker it could not stop.
   */
  function stopResidual(handle) {
    const stopped = run(prefix, ["orchestration", "worker-stop", "--dispatch", handle, "--json"]);
    if (stopped.error) return `could not launch worker-stop: ${stopped.error.message}`;
    if (stopped.status !== 0) return `worker-stop exit ${stopped.status}`;
    const envelope = parseEnvelope(stopped.stdout);
    if (envelope === null) return "unparseable worker-stop reply";
    if (envelope.ok === false) return "worker-stop replied ok: false";
    return null;
  }

  /**
   * Start exactly one Orca worker and return its dispatch id as the handle. A
   * non-zero exit, an `ok: false` envelope, a missing dispatch id or an
   * unparseable reply is a failed start and is thrown; the adapter never
   * retries a failed start, so the caller can rely on exactly one Orca call
   * here. A failed reply that still names a dispatch id - a worker Orca
   * created before the call failed or left with an unknown outcome - is
   * stopped through `worker-stop` before the throw, and the error names that
   * id and Orca's `residualResources`.
   *
   * The stop is checked. When `worker-stop` does not prove the worker gone - a
   * spawn error, a non-zero exit, `ok: false` or an unparseable reply - the
   * thrown error says the residual worker "may still be running", carries the
   * `residualResources` and the start's detail, and sets
   * `startOutcomeUnknown = true`, so the caller can block the next step instead
   * of retrying a start that may already have a live worker. Only a proven stop
   * is reported as "stopped residual worker <id>".
   *
   * The start is refused before any Orca command when it has no spec, no
   * configured agent or no derivable worker name: an empty `--spec`, `--name`
   * or `--agent` value is never passed, so a worker is never started without a
   * brief, a name or an agent.
   *
   * `--base-branch` is emitted only when a base is known: null, undefined and
   * the empty string all omit the flag pair, so Orca uses the repository's
   * default base by its documented omission rather than by passing an empty
   * value (see the module header).
   */
  function start({ stage = null, taskId = null, spec = null } = {}) {
    const specValue = spec == null ? "" : String(spec);
    if (specValue.trim() === "") {
      throw new Error(
        "orca worker-start refused: a non-empty --spec is required, so a worker is never started without a brief",
      );
    }
    if (typeof agent !== "string" || agent.trim() === "") {
      throw new Error(
        "orca worker-start refused: a non-empty agent is required, so a worker is never started without an agent",
      );
    }
    const workerName = name ?? taskId ?? stage;
    const workerNameValue = workerName == null ? "" : String(workerName);
    if (workerNameValue.trim() === "") {
      throw new Error(
        "orca worker-start refused: a worker name is required (a configured name, the taskId or the stage)",
      );
    }
    const baseArgs =
      baseBranch == null || baseBranch === "" ? [] : ["--base-branch", String(baseBranch)];
    const args = [
      "orchestration",
      "worker-start",
      "--spec",
      specValue,
      "--worktree",
      "new-top-level",
      "--name",
      workerNameValue,
      ...baseArgs,
      "--agent",
      agent,
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
      const stoppedId = residualDispatchId(envelope);
      const stopFailure = stoppedId === null ? null : stopResidual(stoppedId);
      const detail = (result.stderr || "").trim() || (result.stdout || "").trim();
      const error = new Error(
        startFailureMessage({ status: result.status, stoppedId, stopFailure, envelope, detail }),
      );
      if (stopFailure !== null) error.startOutcomeUnknown = true;
      throw error;
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
