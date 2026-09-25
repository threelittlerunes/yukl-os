#!/usr/bin/env node
// Runtime adapter interface for the lifecycle runner.
//
// A runtime adapter is the seam between the lifecycle runner and whatever
// actually executes a pipeline stage: a local process, a coding agent CLI, a
// remote executor or a test double. The runner talks to an adapter only
// through the four required methods below, so the lifecycle directory stays
// free of any single agent's vocabulary and of hard imports of a particular
// adapter (see tests/runtime-neutrality.test.js).
//
// Interface:
//
//   start({ stage, taskId, spec, worktree, env }) -> handle
//     Launch the agent for one stage and return an opaque handle. The caller
//     passes the dispatch environment in `env`; the adapter must forward
//     `env.YUKL_DISPATCH_ID` to the agent process so a run can be traced back
//     to the dispatch that started it.
//   status(handle) -> "live" | "exited" | "unverifiable"
//     Report what is known about a handle. "unverifiable" is the honest answer
//     when the handle was not produced by this adapter or its fate is unknown.
//   result(handle) -> any
//     The terminal outcome of a handle: an exit code, artefacts, logs, or
//     whatever else the adapter can prove happened.
//   stop(handle) -> void
//     Ask the agent to stop. The adapter may ignore the request once the
//     handle has already exited.
//   workspace(handle) -> { path } | null          (optional)
//     The checkout the agent for `handle` actually worked in, or null when
//     this adapter cannot say. Implementing it opts the composition root into
//     judging the worker's own commit: `yukl run` resolves that checkout's HEAD
//     and anchors the completed stage and runs path enforcement there instead
//     of at the orchestrator checkout's HEAD and branch. A foreign handle, an
//     unreadable worker record or a reply that names no path yields null - the
//     caller blocks for a human rather than falling back to the wrong commit. A
//     runtime without this method keeps the older behaviour unchanged.

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isCommandName } from "../yukl.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the directory holding the bundled adapters. */
export const ADAPTERS_DIR = join(HERE, "..", "adapters");

const RUNTIME_METHODS = ["start", "status", "result", "stop"];

/**
 * True when `candidate` is a non-null object exposing every runtime method as
 * a function. Purely structural: it checks the shape, never any behaviour. The
 * optional `workspace` method is not required here, so an adapter that does not
 * implement it is still a runtime.
 */
export function implementsRuntime(candidate) {
  return (
    candidate != null &&
    typeof candidate === "object" &&
    RUNTIME_METHODS.every((method) => typeof candidate[method] === "function")
  );
}

/**
 * Throw a descriptive error unless `candidate` implements the runtime
 * interface (see implementsRuntime). Returns the candidate unchanged, so the
 * check can be used inline: `const runtime = assertRuntime(makeRuntime())`.
 */
export function assertRuntime(candidate) {
  if (!implementsRuntime(candidate)) {
    throw new Error(`runtime adapter must implement ${RUNTIME_METHODS.join(", ")} as functions`);
  }
  return candidate;
}

/**
 * Load the adapter named `name` from the adapters directory and return its
 * module namespace. The name is checked with the shared command-name rule
 * before anything is imported, so a bad name (a path, capitals, an empty
 * string) is refused without touching the filesystem. The file path is joined
 * from this module's own directory and the validated name rather than written
 * as a literal, which is what keeps the lifecycle directory free of adapter
 * imports that tests/runtime-neutrality.test.js forbids. `adaptersDir` is
 * injectable so tests can point at a temporary directory.
 */
export async function loadAdapter(name, { adaptersDir = ADAPTERS_DIR } = {}) {
  if (!isCommandName(name)) {
    throw new Error(`"${name}" is not a valid adapter name`);
  }
  const file = join(adaptersDir, `${name}.js`);
  return import(pathToFileURL(file).href);
}
