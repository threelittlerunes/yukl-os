#!/usr/bin/env node
// `yukl status` reports a task's folded lifecycle state, the integrity of its
// event log and how that log relates to the run head committed to the base
// branch.
//
//   yukl status <task_id> [--state-dir <dir>] [--base <ref>]
//
// The state directory defaults to `.orchestration/state` from the working
// directory and the base branch to `main`. The report is the folded state
// (stage, attempts, event count), the last recorded decision (its rule or its
// rationale), the chain verification result and, when the base branch carries
// a `Yukl-Run-Head: <task_id> <hash>` trailer for this task, the check that the
// log still contains that committed head.
//
// Events appended after the committed head are an uncommitted tail: the merge
// does not cover them, so they are reported as unverified rather than folded
// into the committed run. A log that is internally consistent but no longer
// contains the committed head (a full rewrite) fails that check even though its
// chain verifies.
//
// Exit codes: 0 when the chain verifies and, when a trailer exists, its head is
// found in the log; 1 on a broken chain, a missing log for the task or a head
// the log no longer contains; 2 on a usage error.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { foldState, readEvents, verifyAgainstHead, verifyChain } from "../lifecycle/events.js";

const DEFAULT_STATE_DIR = ".orchestration/state";
const DEFAULT_BASE = "main";
// The same safe single path segment the event log enforces, checked here so an
// unsafe task id is a usage error (2) rather than an exception from readEvents.
const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const TRAILER_PREFIX = "Yukl-Run-Head: ";
// %H is the commit hash, %B its raw body and %x00 / %x1e are NUL and the record
// separator, so a body may contain any newlines without confusing the parse.
const TRAILER_FORMAT = "--format=%H%x00%B%x1e";

/**
 * Parse the raw arguments after `status`. Returns `{ error }` for a usage
 * problem (the caller exits 2) or `{ taskId, stateDir, base }`. Task id is the
 * one positional; unknown flags, a second positional and a flag without a
 * value are all refused, so a typo can never be silently ignored.
 */
export function parseArgs(argv) {
  const values = { taskId: null, stateDir: null, base: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--state-dir" || arg === "--base") {
      if (i + 1 >= argv.length) return { error: `missing value for ${arg}` };
      const value = argv[++i];
      if (value === "") return { error: `missing value for ${arg}` };
      if (arg === "--state-dir") values.stateDir = value;
      else values.base = value;
    } else if (arg.startsWith("--")) {
      return { error: `unknown option "${arg}"` };
    } else if (values.taskId === null) {
      values.taskId = arg;
    } else {
      return { error: `unexpected argument "${arg}"` };
    }
  }
  if (values.taskId === null) return { error: "missing task id" };
  if (!TASK_ID_RE.test(values.taskId)) {
    return { error: `invalid task id "${values.taskId}"` };
  }
  return values;
}

/** SHA-256 of a raw line, as lower-case hex. */
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Run git with an argument array (never a shell) and capture its output. */
function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * The run-head hash a commit body carries for `taskId`, or null when it carries
 * none. Only lines that start with the trailer prefix are considered, and the
 * task id must match exactly, so a trailer for another task is ignored.
 */
export function runHeadHashForTask(body, taskId) {
  for (const line of String(body).split(/\r?\n/)) {
    if (!line.startsWith(TRAILER_PREFIX)) continue;
    const parts = line.slice(TRAILER_PREFIX.length).trim().split(/\s+/);
    if (parts.length >= 2 && parts[0] === taskId) return parts[1];
  }
  return null;
}

/**
 * The newest `Yukl-Run-Head: <taskId> <hash>` trailer reachable from `base`, or
 * null when the branch carries none. `git log` walks commits newest first, so
 * the first matching trailer is the newest; trailers for other tasks (even
 * newer ones) are skipped. Returns `{ ok: true, sha, hash }` where `sha` is the
 * merge commit, or `{ ok: false, error }` when `base` cannot be read.
 */
export function findRunHeadTrailer(base, taskId, cwd) {
  const log = git(["log", base, TRAILER_FORMAT], cwd);
  if (log.status !== 0) {
    return { ok: false, error: (log.stderr || "").trim() || `git log ${base} failed` };
  }
  for (const record of String(log.stdout).split("\x1e")) {
    const text = record.replace(/^\r?\n/, "");
    if (text === "") continue;
    const separator = text.indexOf("\x00");
    if (separator === -1) continue;
    const sha = text.slice(0, separator).trim();
    const hash = runHeadHashForTask(text.slice(separator + 1), taskId);
    if (hash !== null) return { ok: true, sha, hash };
  }
  return { ok: true, sha: null, hash: null };
}

/**
 * A one-line summary of the last recorded decision: the latest `decision` or
 * `human_decision` event, described by its rule when deterministic, otherwise
 * its rationale (or the human decision and its reason). "none" when the log
 * carries no decision.
 */
export function describeDecision(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === null || typeof event !== "object") continue;
    if (event.type === "decision") {
      const decision = event.decision;
      if (decision !== null && typeof decision === "object") {
        if (typeof decision.rule === "string" && decision.rule !== "") {
          return `rule ${decision.rule}`;
        }
        if (typeof decision.rationale === "string" && decision.rationale !== "") {
          return `rationale ${decision.rationale}`;
        }
        if (typeof decision.kind === "string" && decision.kind !== "") return decision.kind;
      }
      return "recorded without a rule or rationale";
    }
    if (event.type === "human_decision") {
      const data = event.data ?? {};
      const decision = typeof data.decision === "string" ? data.decision : "decision";
      const reason =
        typeof data.reason === "string" && data.reason !== "" ? ` (${data.reason})` : "";
      return `human ${decision}${reason}`;
    }
  }
  return "none";
}

/** The index of the raw line that hashes to `hash`, or -1 when none does. */
function lineIndexForHash(lines, hash) {
  for (let i = 0; i < lines.length; i++) {
    if (sha256(lines[i]) === hash) return i;
  }
  return -1;
}

/**
 * Run `yukl status`. Returns the process exit code. A usage problem returns 2;
 * a missing log, a broken chain or a committed head the log no longer contains
 * returns 1; otherwise 0.
 */
export function run(argv = []) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`yukl status: ${parsed.error}`);
    return 2;
  }

  const cwd = process.cwd();
  const stateDir = resolve(parsed.stateDir ?? DEFAULT_STATE_DIR);
  const base = parsed.base ?? DEFAULT_BASE;
  const logPath = join(stateDir, `${parsed.taskId}.jsonl`);
  if (!existsSync(logPath)) {
    console.error(
      `yukl status: no event log for task ${parsed.taskId} at ${logPath}; ` +
        "check the task id and --state-dir",
    );
    return 1;
  }

  const log = readEvents(stateDir, parsed.taskId);
  const state = foldState(log);
  const chain = verifyChain(log);

  console.log(`task: ${parsed.taskId}`);
  console.log(
    `state: stage=${state.stage ?? "none"} attempts=${state.attempts} events=${state.count}`,
  );
  console.log(`last decision: ${describeDecision(log.events)}`);

  if (!chain.ok) {
    console.log(`chain: broken at line ${chain.line}: ${chain.error}`);
    console.error(`yukl status: chain verification failed at line ${chain.line}: ${chain.error}`);
    return 1;
  }
  console.log("chain: ok");

  const trailer = findRunHeadTrailer(base, parsed.taskId, cwd);
  if (!trailer.ok) {
    console.log(`committed head: cannot read trailers from ${base}`);
    console.error(`yukl status: cannot read trailers from ${base}: ${trailer.error}`);
    return 1;
  }
  if (trailer.hash === null) {
    console.log(`committed head: none for this task on ${base}`);
    return 0;
  }

  console.log(`committed head: ${trailer.hash} (merge commit ${trailer.sha})`);
  const against = verifyAgainstHead(log, trailer.hash);
  if (!against.ok) {
    console.log(`head: not found (${against.error})`);
    console.error(`yukl status: ${against.error}`);
    return 1;
  }

  const index = lineIndexForHash(log.lines, trailer.hash);
  const tail = index < 0 ? log.lines.length : log.lines.length - index - 1;
  console.log(`head: found at event ${index}`);
  console.log(
    `uncommitted tail: ${tail} event(s) after the committed head; ` +
      "they are not covered by any committed head and are not verified",
  );
  return 0;
}
