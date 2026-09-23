// Per-task event log for the lifecycle engine (v2-w1).
//
// One append-only JSONL file per task, `<dir>/<taskId>.jsonl`, where each line
// is a self-contained event and the whole state of a task is a pure fold of its
// log. Lines are chained: every event stores in `prev` the SHA-256 (hex) of the
// raw bytes of the previous line, so any later edit, insertion or removal shows
// up as a mismatch. The first event carries `prev: null` and `seq` counts from
// 0. `appendEvent` owns the bookkeeping fields (`seq`, `at`, `taskId`, `prev`);
// callers only describe what happened (`type`, `actor`, `data` and the optional
// `anchor`/`decision`).
//
// Lines are written one at a time with an fsync before the file is closed, so a
// crash can leave at most a torn final line. `readEvents` reports that partial
// tail instead of hiding it, and ignores it for folding and verification; a
// break anywhere earlier in the file is fatal.

import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

// Task ids name a file, so they are restricted to one safe path segment: a
// lower-case alphanumeric start followed by alphanumerics, dots, underscores or
// hyphens. This rejects separators and ".." before any path is built.
const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

// The raw line a parsed event came from is kept as a hidden symbol property so
// that callers get a clean event object (JSON.stringify ignores it) while the
// verifiers can still hash the exact bytes.
const RAW_LINE = Symbol("rawLine");

/** Throw unless `taskId` is a safe single path segment. */
function assertTaskId(taskId) {
  if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId)) {
    throw new Error(
      `invalid taskId ${JSON.stringify(taskId)}: expected a lower-case path segment matching ${TASK_ID_RE}`,
    );
  }
}

/** Absolute path of a task's log file. */
function eventsPath(dir, taskId) {
  return join(dir, `${taskId}.jsonl`);
}

/** SHA-256 of a raw line, as lower-case hex. */
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Split a log's text into complete lines and an optional partial tail.
 * A file that ends in "\n" has no partial tail; anything after the last "\n"
 * is returned as `partialTail` and excluded from `lines`.
 */
function splitLines(text) {
  if (text === "") return { lines: [], partialTail: null };
  const parts = text.split("\n");
  if (text.endsWith("\n")) {
    parts.pop();
    return { lines: parts, partialTail: null };
  }
  const partialTail = parts.pop();
  return { lines: parts, partialTail };
}

/** Read a log file, treating a missing file as an empty log. */
function readLogText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Append one event to a task's log. `event` supplies `type` (required),
 * `actor`, `data` and the optional `anchor`/`decision`; `seq`, `at`, `taskId`
 * and `prev` are filled in here. The line is flushed to disk with fsync before
 * the call returns. Returns the stored event.
 *
 * A torn final line from an earlier crash is dropped before appending: it was
 * never a committed event, and leaving it in place would corrupt the next
 * line's chaining. The directory is created when missing.
 */
export function appendEvent(dir, taskId, event = {}) {
  assertTaskId(taskId);
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("event must be an object");
  }
  if (typeof event.type !== "string" || event.type.trim() === "") {
    throw new Error("event.type must be a non-empty string");
  }

  const path = eventsPath(dir, taskId);
  mkdirSync(dir, { recursive: true });

  const { lines, partialTail } = splitLines(readLogText(path));
  if (partialTail !== null) {
    const prefix = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    truncateSync(path, Buffer.byteLength(prefix, "utf8"));
  }

  const seq = lines.length;
  const prev = lines.length === 0 ? null : sha256(lines[lines.length - 1]);
  const record = {
    seq,
    at: new Date().toISOString(),
    taskId,
    type: event.type,
    actor: event.actor ?? null,
  };
  if (event.anchor !== undefined) record.anchor = event.anchor;
  if (event.decision !== undefined) record.decision = event.decision;
  record.data = event.data ?? {};
  record.prev = prev;

  const line = JSON.stringify(record);
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${line}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return record;
}

/**
 * Read a task's log from disk.
 * Returns `{ events, lines, partialTail }` where `lines` holds the exact raw
 * bytes of every complete line (newline stripped) and `events[i]` is the parsed
 * object for `lines[i]`, or `null` when that line is not a JSON object. A
 * trailing partial line is returned separately and never appears in `lines` or
 * `events`. A missing file reads as an empty log.
 */
export function readEvents(dir, taskId) {
  assertTaskId(taskId);
  const { lines, partialTail } = splitLines(readLogText(eventsPath(dir, taskId)));
  const events = lines.map((line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    Object.defineProperty(parsed, RAW_LINE, { value: line });
    return parsed;
  });
  return { events, lines, partialTail };
}

/**
 * Normalise the accepted inputs of the chain functions to `{ event, raw }`
 * pairs. Accepts either the `readEvents` result or a bare array of events
 * (their raw lines come from the hidden property attached by `readEvents`).
 * Returns null for anything else.
 */
function toEntries(events) {
  if (Array.isArray(events)) {
    return events.map((event) => ({ event, raw: event?.[RAW_LINE] }));
  }
  if (events !== null && typeof events === "object" && Array.isArray(events.events)) {
    const lines = Array.isArray(events.lines) ? events.lines : [];
    return events.events.map((event, i) => ({ event, raw: event?.[RAW_LINE] ?? lines[i] }));
  }
  return null;
}

/**
 * Verify the internal integrity of a log: every line parses to an object, `seq`
 * counts from 0 without gaps, the first event's `prev` is null, and every other
 * event's `prev` is the SHA-256 of the raw line before it. A trailing partial
 * line is not passed here (see `readEvents`); any earlier break is reported.
 *
 * Returns `{ ok: true }` or `{ ok: false, error, line }` where `line` is the
 * 1-based number of the line at fault. For a byte edit that is the edited line
 * itself (detected through its successor's `prev`); for a bad `seq` or an
 * unparseable line it is the line where the break surfaces.
 */
export function verifyChain(events) {
  const entries = toEntries(events);
  if (entries === null) {
    return { ok: false, error: "expected an array of events or a readEvents result", line: null };
  }
  for (let i = 0; i < entries.length; i++) {
    const { event, raw } = entries[i];
    if (event === null || typeof event !== "object") {
      return { ok: false, error: `line ${i + 1} is not a JSON object`, line: i + 1 };
    }
    if (event.seq !== i) {
      return { ok: false, error: `line ${i + 1}: seq ${event.seq} is not ${i}`, line: i + 1 };
    }
    if (i === 0) {
      if (event.prev !== null) {
        return { ok: false, error: "line 1: prev must be null on the first event", line: 1 };
      }
    } else {
      const prior = entries[i - 1].raw;
      if (typeof prior !== "string") {
        return {
          ok: false,
          error: `line ${i + 1}: the raw bytes of the previous line are unavailable, cannot verify the chain`,
          line: i + 1,
        };
      }
      const expected = sha256(prior);
      if (event.prev !== expected) {
        // The bytes of line i (1-based) no longer match the hash that line
        // i + 1 recorded for it, so line i is the one that changed.
        return {
          ok: false,
          error: `line ${i}: bytes no longer match the hash recorded by line ${i + 1}`,
          line: i,
        };
      }
    }
  }
  return { ok: true };
}

/** SHA-256 of the last raw line, or null for an empty log. */
export function headHash(events) {
  const entries = toEntries(events);
  if (entries === null || entries.length === 0) return null;
  const last = entries[entries.length - 1].raw;
  return typeof last === "string" ? sha256(last) : null;
}

/**
 * Confirm that `committedHead` is anchored in the log: at least one raw line
 * must hash to it. A full rewrite, even with an internally consistent chain,
 * cannot reproduce the old head and so fails here. `committedHead` of null is
 * the head of an empty log, so it verifies only against an empty log.
 * Returns `{ ok, error? }`.
 */
export function verifyAgainstHead(events, committedHead) {
  const entries = toEntries(events);
  if (entries === null) {
    return { ok: false, error: "expected an array of events or a readEvents result" };
  }
  if (entries.length === 0) {
    return committedHead == null
      ? { ok: true }
      : { ok: false, error: "the log is empty, so it cannot carry the committed head" };
  }
  const matched = entries.some(
    ({ raw }) => typeof raw === "string" && sha256(raw) === committedHead,
  );
  return matched
    ? { ok: true }
    : { ok: false, error: `no line in the log hashes to the committed head ${committedHead}` };
}

/**
 * Fold a log into its state, pure over the events (nothing is read from disk).
 * `stage` is the value of `data.stage` on the latest event that carries one, or
 * `data.to` on the latest event that carries no `stage`; both name the stage a
 * transition moves to, and the latest such event wins. `attempts` counts events
 * whose type mentions an attempt, `lastEvent` is the final event object and
 * `count` is the number of events.
 */
export function foldState(events) {
  const entries = toEntries(events);
  const list = entries === null ? [] : entries.map(({ event }) => event);
  const state = { taskId: null, stage: null, attempts: 0, lastEvent: null, count: list.length };
  for (const event of list) {
    if (event === null || typeof event !== "object") continue;
    if (state.taskId === null && typeof event.taskId === "string") state.taskId = event.taskId;
    const data = event.data;
    if (data !== null && typeof data === "object") {
      if (typeof data.stage === "string") state.stage = data.stage;
      else if (typeof data.to === "string") state.stage = data.to;
    }
    if (typeof event.type === "string" && /attempt/i.test(event.type)) state.attempts += 1;
    state.lastEvent = event;
  }
  return state;
}
