#!/usr/bin/env node
// Minimal advisory lock broker for .orchestration/locks/.
//
// Tandem concurrency: two agents (or two schedulers) must never mutate the same
// shared resource at once - a dependency install, a task's worktree, a branch.
// A lock is one file, `<locksDir>/<name>.lock`, and the exclusive create of that
// file IS the mutual exclusion: `writeFileSync` with the `wx` flag fails with
// EEXIST when someone else holds it, so no lock manager and no second state
// store are needed. The file records its owner as JSON: `{ name, pid, host,
// task, at }`. The owner releases the lock by removing the file.
//
// A lock whose recorded process is gone is stale - the owner crashed or was
// killed before it could release - and a later acquirer reclaims it instead of
// blocking forever. Nothing is taken on trust beyond that: a lock file that
// cannot be parsed is refused, not reclaimed, because the broker cannot prove
// that its owner is gone and guessing would hand out a lock someone may hold.
//
// The clock, the process id, the host name and the liveness check are all
// injectable, so the behaviour is testable without a real process, a real clock
// or a real crash.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/** The suffix every lock file carries. */
export const LOCK_SUFFIX = ".lock";

// A lock name names a file, so it is restricted to one safe path segment, the
// same shape the task ids and log files enforce.
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

// How many times a lost race (the file vanished between the inspect and the
// reclaim) is retried before the broker gives up and reports the holder.
const MAX_ATTEMPTS = 3;

/** True when `name` is a safe single path segment for a lock file. */
export function isLockName(name) {
  return typeof name === "string" && NAME_RE.test(name);
}

/** Absolute path of the lock file for `name` in `dir`. Throws on a bad name. */
export function lockPath(dir, name) {
  if (!isLockName(name)) {
    throw new Error(`"${name}" is not a valid lock name`);
  }
  return join(dir, `${name}${LOCK_SUFFIX}`);
}

/**
 * True when `pid` names a live process. Signal 0 performs the permission and
 * existence check without delivering a signal; EPERM means the process exists
 * but belongs to another user, which still counts as alive.
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/** The shape an owner record must have to be judged. */
function isOwner(owner) {
  return (
    owner !== null &&
    typeof owner === "object" &&
    typeof owner.name === "string" &&
    Number.isInteger(owner.pid) &&
    typeof owner.host === "string" &&
    typeof owner.at === "string"
  );
}

/**
 * Inspect a lock without taking it. Returns one of:
 *   `{ state: "absent" }`
 *   `{ state: "held", owner, path }`
 *   `{ state: "unreadable", path, detail }`
 * An unreadable lock is reported rather than treated as absent: a caller that
 * reclaims it could steal a lock another process is holding.
 */
export function inspectLock(dir, name) {
  const path = lockPath(dir, name);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { state: "absent", path };
    return { state: "unreadable", path, detail: err?.message ?? String(err) };
  }
  let owner;
  try {
    owner = JSON.parse(text);
  } catch (err) {
    return { state: "unreadable", path, detail: `owner record is not JSON: ${err.message}` };
  }
  if (!isOwner(owner)) {
    return { state: "unreadable", path, detail: "owner record is missing name, pid, host or at" };
  }
  return { state: "held", owner, path };
}

/** Create the lock file exclusively. Never overwrites an existing lock. */
function createExclusive(path, owner) {
  try {
    writeFileSync(path, `${JSON.stringify(owner)}\n`, { flag: "wx" });
    return { ok: true };
  } catch (err) {
    if (err?.code === "EEXIST") return { ok: false, exists: true };
    return { ok: false, exists: false, detail: err?.message ?? String(err) };
  }
}

/**
 * Acquire the lock `name` in `dir`. Returns one of:
 *   `{ ok: true, path, owner, reclaimed, holder? }` - the lock is ours;
 *     `reclaimed` is true when a stale lock was removed first, and `holder` is
 *     the dead owner whose lock was reclaimed.
 *   `{ ok: false, reason: "held", path, holder }` - a live owner holds it.
 *   `{ ok: false, reason: "unreadable", path, detail }` - the lock file exists
 *     but cannot be judged, so it is left alone.
 *   `{ ok: false, reason: "error", path, detail }` - the file could not be
 *     created.
 * The lock directory is created when it is missing, so a fresh checkout needs
 * no setup step.
 */
export function acquireLock({
  dir,
  name,
  task = null,
  pid = process.pid,
  host = hostname(),
  clock = () => new Date(),
  alive = isProcessAlive,
} = {}) {
  const path = lockPath(dir, name);
  mkdirSync(dir, { recursive: true });
  const owner = { name, pid, host, task, at: clock().toISOString() };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const created = createExclusive(path, owner);
    if (created.ok) {
      return { ok: true, path, owner, reclaimed: false };
    }
    if (created.exists !== true) {
      return { ok: false, reason: "error", path, detail: created.detail };
    }

    const current = inspectLock(dir, name);
    if (current.state === "absent") continue;
    if (current.state === "unreadable") {
      return { ok: false, reason: "unreadable", path, detail: current.detail };
    }
    if (alive(current.owner.pid)) {
      return { ok: false, reason: "held", path, holder: current.owner };
    }
    // The owner is gone: reclaim. A concurrent acquirer may win the next
    // exclusive create, in which case the loop inspects the new owner.
    rmSync(path, { force: true });
    const reclaimed = createExclusive(path, owner);
    if (reclaimed.ok) {
      return { ok: true, path, owner, reclaimed: true, holder: current.owner };
    }
  }

  const last = inspectLock(dir, name);
  if (last.state === "held") return { ok: false, reason: "held", path, holder: last.owner };
  return {
    ok: false,
    reason: "error",
    path,
    detail: "the lock changed hands on every attempt",
  };
}

/**
 * Release the lock `name` in `dir`. Returns
 * `{ ok: true, path, released, holder? }` where `released` is false when the
 * lock was already absent; releasing a lock nobody holds is not an error, so a
 * `finally` cleanup is safe. When `pid` is given the release is refused unless
 * that process owns the lock (`reason: "not-owner"`), and `force` releases it
 * whatever the owner record says.
 */
export function releaseLock({ dir, name, pid = null, force = false } = {}) {
  const current = inspectLock(dir, name);
  if (current.state === "absent") {
    return { ok: true, path: current.path, released: false };
  }
  if (current.state === "unreadable") {
    if (!force) {
      return { ok: false, path: current.path, reason: "unreadable", detail: current.detail };
    }
    rmSync(current.path, { force: true });
    return { ok: true, path: current.path, released: true };
  }
  if (!force && pid !== null && current.owner.pid !== pid) {
    return { ok: false, path: current.path, reason: "not-owner", holder: current.owner };
  }
  rmSync(current.path, { force: true });
  return { ok: true, path: current.path, released: true, holder: current.owner };
}
