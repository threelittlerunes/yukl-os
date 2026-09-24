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
// blocking forever. Reclaiming is not atomic with the inspection that found the
// owner dead, so it goes through a second, exclusive guard file
// `<name>.lock.reclaim`: only the guard holder may remove the stale lock, and
// it re-reads the lock first and removes it only while it still names the same
// dead owner. Without that guard two acquirers could both see the dead owner,
// both remove, and the later rmSync would delete the lock the earlier one had
// just created - leaving two holders of one lock.
//
// Nothing is taken on trust beyond that: a lock file that cannot be parsed is
// refused, not reclaimed, because the broker cannot prove that its owner is
// gone and guessing would hand out a lock someone may hold. The guard records
// its owner like any lock, so a reclaimer that crashed mid-reclaim leaves a
// stale guard the next acquirer reclaims in turn.
//
// One window is known to remain open, and no code here closes it. Reclaiming a
// stale guard is itself not serialised - there is no guard for the guard - so
// two acquirers colliding on the guard of a reclaimer that crashed mid-reclaim
// can in principle both take it: each removes the guard it found and creates its
// own, and both then inspect and remove the stale lock. The same-owner re-check
// each performs on the lock narrows the window to the interval between one
// acquirer's re-read and its removal, but does not close it, because a second
// acquirer that re-read the same dead owner inside that interval still removes
// the lock the first has just created. Closing it would take an unbounded tower
// of guards, or a lock primitive the file system does not offer portably; the
// worst case is a lost advisory lock under a crash inside a crash, not corrupt
// state, so the broker keeps the single guard and records the limit here.
//
// The clock, the process id, the host name and the liveness check are all
// injectable, so the behaviour is testable without a real process, a real clock
// or a real crash.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/** The suffix every lock file carries. */
export const LOCK_SUFFIX = ".lock";

// The suffix of the exclusive guard that serialises reclaiming a stale lock, so
// the guard of `a.lock` is `a.lock.reclaim`.
const RECLAIM_SUFFIX = ".reclaim";

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
  return inspectPath(lockPath(dir, name));
}

/**
 * Inspect one lock file, whichever file it is: the lock itself or the reclaim
 * guard beside it. Same shapes as `inspectLock`.
 */
function inspectPath(path) {
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

/**
 * Absolute path of the reclaim guard for lock `name`: the exclusive lock that
 * serialises reclaiming a stale `<name>.lock`. It records its owner like any
 * lock file, so a reclaimer that crashed mid-reclaim leaves a stale guard that
 * a later acquirer reclaims in turn.
 */
export function reclaimPath(dir, name) {
  return `${lockPath(dir, name)}${RECLAIM_SUFFIX}`;
}

/** True when two owner records name the same process at the same moment. */
function sameOwner(left, right) {
  return (
    left.name === right.name &&
    left.pid === right.pid &&
    left.host === right.host &&
    left.at === right.at
  );
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
 * Take the reclaim guard `guardPath` - the exclusive lock that lets exactly one
 * acquirer reclaim a stale lock. Returns `{ ok: true }` when the guard is ours,
 * `{ ok: false, reason: "busy", holder }` when a live reclaimer holds it,
 * `{ ok: false, reason: "unreadable", detail }` when the guard exists but
 * cannot be judged, and `{ ok: false, reason: "error", detail }` when it could
 * not be created. A guard whose recorded process is dead - a reclaimer that
 * crashed mid-reclaim - is stale and is removed so the reclaim can proceed.
 */
function takeReclaimGuard({ guardPath, owner, alive }) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const created = createExclusive(guardPath, owner);
    if (created.ok) return { ok: true };
    if (created.exists !== true) return { ok: false, reason: "error", detail: created.detail };

    const current = inspectPath(guardPath);
    if (current.state === "absent") continue;
    if (current.state === "unreadable") {
      return {
        ok: false,
        reason: "unreadable",
        detail: `reclaim guard ${guardPath} cannot be read: ${current.detail}`,
      };
    }
    if (alive(current.owner.pid)) return { ok: false, reason: "busy", holder: current.owner };
    rmSync(guardPath, { force: true });
  }
  return {
    ok: false,
    reason: "error",
    detail: "the reclaim guard changed hands on every attempt",
  };
}

/** Remove the reclaim guard, but only while it still names us as its owner. */
function releaseReclaimGuard(guardPath, owner) {
  const current = inspectPath(guardPath);
  if (current.state === "held" && sameOwner(current.owner, owner)) {
    rmSync(guardPath, { force: true });
  }
}

/**
 * Acquire the lock `name` in `dir`. Returns one of:
 *   `{ ok: true, path, owner, reclaimed, holder? }` - the lock is ours;
 *     `reclaimed` is true when a stale lock was removed first, and `holder` is
 *     the dead owner whose lock was reclaimed.
 *   `{ ok: false, reason: "held", path, holder }` - a live owner holds it, or
 *     another acquirer is reclaiming it right now (the holder named is then the
 *     live reclaimer that holds the reclaim guard).
 *   `{ ok: false, reason: "unreadable", path, detail }` - the lock file exists
 *     but cannot be judged, so it is left alone.
 *   `{ ok: false, reason: "error", path, detail }` - the file could not be
 *     created.
 * The lock directory is created when it is missing, so a fresh checkout needs
 * no setup step. `beforeReclaim` is an injected hook called with
 * `{ phase, path, guardPath, owner }` while this acquirer holds the reclaim
 * guard: `phase: "inspect"` just before it re-reads the stale lock and
 * `phase: "remove"` just before it removes it. The race tests drive a second
 * acquirer or a lock that changes hands from inside those hooks.
 */
export function acquireLock({
  dir,
  name,
  task = null,
  pid = process.pid,
  host = hostname(),
  clock = () => new Date(),
  alive = isProcessAlive,
  beforeReclaim = null,
} = {}) {
  const path = lockPath(dir, name);
  const guardPath = reclaimPath(dir, name);
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
    // The owner is gone. Removing its lock is not atomic with the inspection
    // above: two acquirers that both saw the dead owner would both remove, and
    // the later rmSync would delete the lock the earlier one had just created,
    // so both would hold it. Reclaim under the exclusive guard instead - only
    // the guard holder may remove - and re-read the lock under the guard, so
    // the removal happens only while the lock still names the same dead owner.
    const guard = takeReclaimGuard({ guardPath, owner, alive });
    if (!guard.ok) {
      if (guard.reason === "busy") {
        return { ok: false, reason: "held", path, holder: guard.holder };
      }
      return { ok: false, reason: guard.reason, path, detail: guard.detail };
    }
    try {
      if (typeof beforeReclaim === "function") {
        beforeReclaim({ phase: "inspect", path, guardPath, owner: current.owner });
      }
      const again = inspectLock(dir, name);
      const stillStale =
        again.state === "held" && sameOwner(again.owner, current.owner) && !alive(again.owner.pid);
      if (stillStale) {
        if (typeof beforeReclaim === "function") {
          beforeReclaim({ phase: "remove", path, guardPath, owner: current.owner });
        }
        rmSync(path, { force: true });
        const reclaimed = createExclusive(path, owner);
        if (reclaimed.ok) {
          return { ok: true, path, owner, reclaimed: true, holder: current.owner };
        }
        // Another acquirer recreated the lock under us: the next attempt
        // inspects it and reports its live owner.
      }
    } finally {
      releaseReclaimGuard(guardPath, owner);
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
