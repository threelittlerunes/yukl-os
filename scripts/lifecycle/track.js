#!/usr/bin/env node
// Runtime track record and earned autonomy level (v2-w2).
//
// How much a runtime may do without a human is derived from what that runtime
// has provably done, never from what it claims about itself. This module is a
// set of pure functions over a task's event log: nothing here reads the file
// system, git or the clock, and nothing here imports an adapter, so the
// lifecycle directory keeps its runtime neutrality (see
// tests/runtime-neutrality.test.js).
//
//   trackRecord(events, runtimeName)   fold a log into one runtime's counts of
//                                      clean audits, failed audits and
//                                      enforcement stops;
//   autonomyLevel(record, policy)      turn those counts and the policy's
//                                      thresholds into an earned level;
//   autonomyChangeEvent(input)          build the engine-authored
//                                      `autonomy_change` event that records a
//                                      move between two levels.
//
// Only `audit_verdict` and `enforcement` events carry weight. An
// `autonomy_change` event is never counted and never trusted, whatever actor
// wrote it, so an agent cannot talk its way up a level.

export const AUTONOMY_ENGINE_ACTOR = "engine";
export const R_AUTONOMY_UP = "R-AUTONOMY-UP";
export const R_AUTONOMY_DOWN = "R-AUTONOMY-DOWN";

/**
 * The event objects in `events`, accepting either a bare array or the
 * `{ events, lines, partialTail }` result of `readEvents`. Anything else reads
 * as no events. Kept local so this module depends on no other module.
 */
function eventList(events) {
  if (Array.isArray(events)) return events;
  if (events !== null && typeof events === "object" && Array.isArray(events.events)) {
    return events.events;
  }
  return [];
}

/** The `data` object of an event, or null when it is not a plain object. */
function dataOf(event) {
  const data = event?.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  return data;
}

/**
 * Fold `events` into the record of one runtime: how many audits it passed,
 * how many it failed and how many stages it was stopped on.
 *
 * A clean or failed audit is an `audit_verdict` event whose `data.runtime` is
 * `runtimeName` and whose `data.verdict` is `"pass"` or `"fail"`. An
 * enforcement stop is an `enforcement` event whose stage is attributed to this
 * runtime by the most recent preceding `stage_started` for that same stage; a
 * stop on a stage nobody started is attributed to nobody.
 *
 * Returns a plain object `{ runtime, cleanAudits, failedAudits,
 * enforcementStops }`. Every other event type, `autonomy_change` included, is
 * ignored, so a level claim written by an agent can never enter the record.
 * An absent or empty `runtimeName` yields an all-zero record.
 */
export function trackRecord(events, runtimeName) {
  const record = { runtime: null, cleanAudits: 0, failedAudits: 0, enforcementStops: 0 };
  if (typeof runtimeName !== "string" || runtimeName.trim() === "") return record;
  record.runtime = runtimeName;

  const stageRuntime = new Map();
  for (const event of eventList(events)) {
    if (event === null || typeof event !== "object") continue;
    const data = dataOf(event);
    if (data === null) continue;

    if (event.type === "stage_started") {
      if (typeof data.stage === "string" && typeof data.runtime === "string") {
        stageRuntime.set(data.stage, data.runtime);
      }
      continue;
    }

    if (event.type === "audit_verdict" && data.runtime === runtimeName) {
      if (data.verdict === "pass") record.cleanAudits += 1;
      else if (data.verdict === "fail") record.failedAudits += 1;
      continue;
    }

    if (event.type === "enforcement" && typeof data.stage === "string") {
      if (stageRuntime.get(data.stage) === runtimeName) record.enforcementStops += 1;
    }
  }

  return record;
}

/** A usable `{ level, minCleanRuns }` threshold. */
function isThreshold(entry) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    Number.isInteger(entry.level) &&
    entry.level >= 0 &&
    Number.isInteger(entry.minCleanRuns) &&
    entry.minCleanRuns >= 0
  );
}

/**
 * The autonomy level earned by `record` under `policy`.
 *
 * The exact rule: start at 0 and walk `policy.trackRecord.levels` in ascending
 * order of `level`; each threshold whose `minCleanRuns` the record's
 * `cleanAudits` has reached raises the level to that entry's `level`, so the
 * highest reached threshold wins. Clamp the result to `policy.ceiling`, then
 * subtract one - once, however many stops there were - when the record holds
 * any enforcement stop, and never go below 0. A level claim stored on the
 * record is ignored: only `cleanAudits` and `enforcementStops` are read.
 */
export function autonomyLevel(record, policy) {
  const ceiling = Number.isInteger(policy?.ceiling) && policy.ceiling >= 0 ? policy.ceiling : 0;
  const cleanAudits = Number.isInteger(record?.cleanAudits) ? record.cleanAudits : 0;
  const stops = Number.isInteger(record?.enforcementStops) ? record.enforcementStops : 0;

  let level = 0;
  const levels = policy?.trackRecord?.levels;
  if (Array.isArray(levels)) {
    const reached = levels
      .filter((entry) => isThreshold(entry) && cleanAudits >= entry.minCleanRuns)
      .sort((a, b) => a.level - b.level);
    for (const entry of reached) level = entry.level;
  }

  if (level > ceiling) level = ceiling;
  if (stops > 0) level -= 1;
  return level < 0 ? 0 : level;
}

/** The refusal shape for a malformed input. */
function refuse(error) {
  return { ok: false, error };
}

/**
 * Build the `autonomy_change` event the engine appends after it moves a
 * runtime from level `from` to level `to`:
 *
 *   { type: "autonomy_change",
 *     actor: "engine",
 *     decision: { kind: "deterministic", rule },
 *     data: { runtime, from, to } }
 *
 * The rule is `"R-AUTONOMY-UP"` for a rise and `"R-AUTONOMY-DOWN"` for a drop.
 * The actor is always `"engine"`, which is what lets `trackRecord` treat the
 * event as the engine's own account and refuse to trust anything else.
 *
 * `runtime` must be a non-empty string and `from`/`to` must be distinct
 * integers >= 0; anything else returns `{ ok: false, error }`.
 */
export function autonomyChangeEvent({ runtime, from, to } = {}) {
  if (typeof runtime !== "string" || runtime.trim() === "") {
    return refuse("runtime must be a non-empty string");
  }
  if (!Number.isInteger(from) || from < 0) {
    return refuse("from must be an integer >= 0");
  }
  if (!Number.isInteger(to) || to < 0) {
    return refuse("to must be an integer >= 0");
  }
  if (to === from) {
    return refuse("to must differ from from; there is no level change to record");
  }
  return {
    type: "autonomy_change",
    actor: AUTONOMY_ENGINE_ACTOR,
    decision: { kind: "deterministic", rule: to > from ? R_AUTONOMY_UP : R_AUTONOMY_DOWN },
    data: { runtime, from, to },
  };
}
