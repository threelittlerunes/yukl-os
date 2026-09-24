import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runLock, describeHolder } from "../scripts/commands/lock.js";
import {
  acquireLock,
  inspectLock,
  isLockName,
  isProcessAlive,
  lockPath,
  reclaimPath,
  releaseLock,
} from "../scripts/lifecycle/locks.js";
import { dispatchCommand } from "../scripts/yukl.js";

const FIXED_AT = "2026-01-01T00:00:00.000Z";
const CLOCK = () => new Date(FIXED_AT);

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-locks-"));
  try {
    return await fn(dir);
  } finally {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (err.code !== "EPERM" && err.code !== "EBUSY") throw err;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
    }
  }
}

/** Capture console output around a call, for the CLI-level checks. */
function capture(fn) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args) => out.push(args.join(" "));
  console.error = (...args) => err.push(args.join(" "));
  try {
    const code = fn();
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

// ---------------------------------------------------------------------------
// names and paths
// ---------------------------------------------------------------------------

test("a lock name is one safe path segment and the path adds the lock suffix", async () => {
  await withTempDir((dir) => {
    assert.equal(lockPath(dir, "npm-install"), join(dir, "npm-install.lock"));
    assert.equal(lockPath(dir, "task.v3_a-b"), join(dir, "task.v3_a-b.lock"));
    for (const bad of ["../evil", "a/b", "", "Npm", "-x", 7, null]) {
      assert.equal(isLockName(bad), false, `${bad} must not be a lock name`);
      assert.throws(() => lockPath(dir, bad), /not a valid lock name/);
    }
  });
});

// ---------------------------------------------------------------------------
// control: exclusive create records the owner and refuses a second acquirer
// ---------------------------------------------------------------------------

test("acquire creates the lock exclusively and records its owner", async () => {
  await withTempDir((dir) => {
    const first = acquireLock({
      dir,
      name: "install",
      task: "v3",
      pid: 4242,
      host: "host-a",
      clock: CLOCK,
    });
    assert.equal(first.ok, true);
    assert.equal(first.reclaimed, false);
    assert.deepEqual(JSON.parse(readFileSync(first.path, "utf8")), {
      name: "install",
      pid: 4242,
      host: "host-a",
      task: "v3",
      at: FIXED_AT,
    });

    const second = acquireLock({
      dir,
      name: "install",
      pid: 9999,
      host: "host-b",
      clock: CLOCK,
      alive: () => true,
    });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "held");
    assert.equal(second.holder.pid, 4242, "the live holder is named, not overwritten");
    assert.equal(
      JSON.parse(readFileSync(first.path, "utf8")).pid,
      4242,
      "a refused acquire leaves the holder's record intact",
    );

    assert.deepEqual(inspectLock(dir, "install"), {
      state: "held",
      path: first.path,
      owner: { name: "install", pid: 4242, host: "host-a", task: "v3", at: FIXED_AT },
    });
    assert.deepEqual(inspectLock(dir, "never-taken"), {
      state: "absent",
      path: lockPath(dir, "never-taken"),
    });
  });
});

test("the lock directory is created when it is missing", async () => {
  await withTempDir((dir) => {
    const nested = join(dir, ".orchestration", "locks");
    const acquired = acquireLock({ dir: nested, name: "fresh", pid: 1, clock: CLOCK });
    assert.equal(acquired.ok, true);
    assert.equal(inspectLock(nested, "fresh").state, "held");
  });
});

// ---------------------------------------------------------------------------
// release on exit: the owner releases, a stranger may not
// ---------------------------------------------------------------------------

test("release removes the owner's lock and is idempotent when it is absent", async () => {
  await withTempDir((dir) => {
    const acquired = acquireLock({ dir, name: "install", pid: 4242, clock: CLOCK });

    const stranger = releaseLock({ dir, name: "install", pid: 1 });
    assert.equal(stranger.ok, false);
    assert.equal(stranger.reason, "not-owner");
    assert.equal(inspectLock(dir, "install").state, "held", "a stranger cannot release the lock");

    const released = releaseLock({ dir, name: "install", pid: 4242 });
    assert.equal(released.ok, true);
    assert.equal(released.released, true);
    assert.equal(released.holder.pid, 4242);
    assert.equal(inspectLock(dir, "install").state, "absent");
    assert.equal(acquired.owner.pid, 4242);

    const again = releaseLock({ dir, name: "install", pid: 4242 });
    assert.deepEqual(again, { ok: true, path: lockPath(dir, "install"), released: false });
  });
});

// ---------------------------------------------------------------------------
// stale reclaim: the owner process is gone
// ---------------------------------------------------------------------------

test("a lock whose owner process is gone is reclaimed, not respected", async () => {
  await withTempDir((dir) => {
    acquireLock({ dir, name: "install", task: "dead", pid: 111, host: "host-a", clock: CLOCK });

    const reclaim = acquireLock({
      dir,
      name: "install",
      task: "alive",
      pid: 222,
      host: "host-b",
      clock: CLOCK,
      alive: (pid) => pid !== 111,
    });
    assert.equal(reclaim.ok, true);
    assert.equal(reclaim.reclaimed, true);
    assert.equal(reclaim.holder.pid, 111, "the dead owner is reported");
    assert.equal(reclaim.owner.pid, 222);
    assert.equal(JSON.parse(readFileSync(reclaim.path, "utf8")).pid, 222, "the lock changed hands");
  });
});

test("a lock held by a live process is never reclaimed", async () => {
  await withTempDir((dir) => {
    acquireLock({ dir, name: "install", pid: 111, clock: CLOCK });
    const refused = acquireLock({
      dir,
      name: "install",
      pid: 222,
      clock: CLOCK,
      alive: () => true,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "held");
    assert.equal(JSON.parse(readFileSync(lockPath(dir, "install"), "utf8")).pid, 111);
  });
});

test("an unreadable lock is refused, never reclaimed", async () => {
  await withTempDir((dir) => {
    const path = lockPath(dir, "install");
    writeFileSync(path, "not json at all");

    const current = inspectLock(dir, "install");
    assert.equal(current.state, "unreadable");
    assert.match(current.detail, /not JSON/);

    const refused = acquireLock({
      dir,
      name: "install",
      pid: 222,
      clock: CLOCK,
      alive: () => false,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "unreadable");
    assert.equal(readFileSync(path, "utf8"), "not json at all", "the file is left alone");

    const release = releaseLock({ dir, name: "install", pid: 222 });
    assert.equal(release.ok, false);
    assert.equal(release.reason, "unreadable");
    assert.equal(releaseLock({ dir, name: "install", pid: 222, force: true }).released, true);
    assert.equal(inspectLock(dir, "install").state, "absent");
  });
});

// ---------------------------------------------------------------------------
// reclaim race: two acquirers that both see a dead owner
// ---------------------------------------------------------------------------

test("two acquirers that both see a dead owner cannot both hold the lock", async () => {
  await withTempDir((dir) => {
    // A dead owner holds the lock; both acquirers would see it as stale.
    acquireLock({ dir, name: "install", task: "dead", pid: 111, host: "host-a", clock: CLOCK });

    const alive = (pid) => pid !== 111;
    // The rival runs inside the hook, at the dangerous point: this acquirer
    // holds the reclaim guard and has just re-read the stale lock, and is about
    // to remove it. Without the guard the rival would remove the lock and
    // create its own here, and this acquirer's rmSync would then delete that
    // live lock - both would report success.
    let rival = null;
    let rivalRuns = 0;
    const first = acquireLock({
      dir,
      name: "install",
      task: "first",
      pid: 333,
      host: "host-c",
      clock: CLOCK,
      alive,
      beforeReclaim: ({ phase }) => {
        if (phase !== "remove") return;
        rivalRuns += 1;
        if (rival !== null) return;
        assert.equal(inspectLock(dir, "install").state, "held", "the stale lock is still there");
        rival = acquireLock({
          dir,
          name: "install",
          task: "rival",
          pid: 222,
          host: "host-b",
          clock: CLOCK,
          alive,
        });
      },
    });

    assert.equal(rivalRuns, 1, "the interleave happens exactly once");
    assert.equal(first.ok, true, "exactly one acquirer holds the lock");
    assert.equal(first.owner.pid, 333);
    assert.equal(rival.ok, false, "the rival does not hold the lock");
    assert.equal(rival.reason, "held", "the rival reports the lock held");
    assert.equal(
      [first.ok, rival.ok].filter(Boolean).length,
      1,
      "exactly one of the two acquirers holds the lock",
    );
    assert.equal(JSON.parse(readFileSync(lockPath(dir, "install"), "utf8")).pid, 333);
    assert.equal(
      readdirSync(dir).includes("install.lock.reclaim"),
      false,
      "the reclaim guard is released once the reclaim settles",
    );
  });
});

test("a lock that changed hands while the reclaim was guarded is not removed", async () => {
  await withTempDir((dir) => {
    acquireLock({ dir, name: "install", task: "dead", pid: 111, host: "host-a", clock: CLOCK });

    const live = { name: "install", pid: 444, host: "host-d", task: "winner", at: FIXED_AT };
    const refused = acquireLock({
      dir,
      name: "install",
      task: "late",
      pid: 333,
      host: "host-c",
      clock: CLOCK,
      alive: (pid) => pid !== 111,
      // The lock changes hands while the guard is held and before the re-read
      // that would act on the dead owner, so the removal must not happen.
      beforeReclaim: ({ phase, path }) => {
        if (phase !== "inspect") return;
        writeFileSync(path, `${JSON.stringify(live)}\n`);
      },
    });

    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "held");
    assert.equal(refused.holder.pid, 444, "the new live owner is reported");
    assert.deepEqual(JSON.parse(readFileSync(lockPath(dir, "install"), "utf8")), live);
  });
});

test("a reclaim guard left by a crashed reclaimer is reclaimed in turn", async () => {
  await withTempDir((dir) => {
    acquireLock({ dir, name: "install", task: "dead", pid: 111, host: "host-a", clock: CLOCK });
    // A reclaimer that crashed between taking the guard and finishing.
    writeFileSync(
      reclaimPath(dir, "install"),
      `${JSON.stringify({ name: "install", pid: 555, host: "host-x", task: "dead", at: FIXED_AT })}\n`,
    );

    const reclaim = acquireLock({
      dir,
      name: "install",
      task: "alive",
      pid: 222,
      host: "host-b",
      clock: CLOCK,
      alive: (pid) => pid !== 111 && pid !== 555,
    });

    assert.equal(reclaim.ok, true);
    assert.equal(reclaim.reclaimed, true);
    assert.equal(reclaim.holder.pid, 111, "the dead lock owner is reported");
    assert.equal(JSON.parse(readFileSync(lockPath(dir, "install"), "utf8")).pid, 222);
    assert.deepEqual(
      readdirSync(dir).filter((entry) => entry.endsWith(".reclaim")),
      [],
      "the stale guard is gone",
    );
  });
});

test("a lock file missing part of its owner record is unreadable", async () => {
  await withTempDir((dir) => {
    writeFileSync(lockPath(dir, "install"), JSON.stringify({ name: "install", pid: "nope" }));
    const current = inspectLock(dir, "install");
    assert.equal(current.state, "unreadable");
    assert.match(current.detail, /missing name, pid, host or at/);
  });
});

test("isProcessAlive judges real pids and refuses nonsense", () => {
  assert.equal(isProcessAlive(process.pid), true, "this test process is alive");
  for (const bad of [0, -1, 2.5, "1", null, undefined, 2147483647]) {
    const judged = isProcessAlive(bad);
    assert.equal(typeof judged, "boolean", `${bad} must be judged, not thrown on`);
  }
});

// ---------------------------------------------------------------------------
// the CLI: hold runs a command under the lock and releases it afterwards
// ---------------------------------------------------------------------------

test("lock hold acquires, runs the command, and releases whatever the command does", async () => {
  await withTempDir(async (dir) => {
    const spawns = [];
    const spawn = (command, args, options) => {
      spawns.push({ command, args, cwd: options.cwd });
      assert.deepEqual(inspectLock(dir, "npm-install"), {
        state: "held",
        path: lockPath(dir, "npm-install"),
        owner: {
          name: "npm-install",
          pid: 777,
          host: "test-host",
          task: "v3-unattended",
          at: FIXED_AT,
        },
      });
      return { status: 3 };
    };

    const held = capture(() =>
      runLock(["hold", "npm-install", "--task", "v3-unattended", "--", "npm", "install"], {
        locksDir: dir,
        pid: 777,
        host: "test-host",
        clock: CLOCK,
        spawn,
      }),
    );
    assert.equal(held.code, 3, "the command's own exit code is propagated");
    assert.deepEqual(spawns, [{ command: "npm", args: ["install"], cwd: process.cwd() }]);
    assert.match(held.out, /lock npm-install: acquired/);
    assert.equal(
      inspectLock(dir, "npm-install").state,
      "absent",
      "the lock is released after the run",
    );
  });
});

test("lock hold refuses a held lock, runs nothing and releases nothing", async () => {
  await withTempDir((dir) => {
    acquireLock({ dir, name: "install", task: "other", pid: 4242, host: "host-a", clock: CLOCK });

    let spawned = 0;
    const held = capture(() =>
      runLock(["hold", "install", "--", "npm", "install"], {
        locksDir: dir,
        pid: 777,
        clock: CLOCK,
        alive: () => true,
        spawn: () => {
          spawned += 1;
          return { status: 0 };
        },
      }),
    );
    assert.equal(held.code, 1);
    assert.equal(spawned, 0, "the command never runs without the lock");
    assert.match(held.err, /held by pid 4242/);
    assert.equal(inspectLock(dir, "install").owner.pid, 4242);
  });
});

test("lock hold reclaims a stale lock and runs the command", async () => {
  await withTempDir((dir) => {
    acquireLock({ dir, name: "install", pid: 111, host: "host-a", clock: CLOCK });
    const held = capture(() =>
      runLock(["hold", "install", "--", "npm", "install"], {
        locksDir: dir,
        pid: 777,
        host: "host-b",
        clock: CLOCK,
        alive: (pid) => pid !== 111,
        spawn: () => ({ status: 0 }),
      }),
    );
    assert.equal(held.code, 0);
    assert.match(held.out, /reclaimed from pid 111 on host-a/);
    assert.equal(inspectLock(dir, "install").state, "absent");
  });
});

test("lock status reports absent, held and unreadable", async () => {
  await withTempDir((dir) => {
    const absent = capture(() => runLock(["status", "install"], { locksDir: dir }));
    assert.equal(absent.code, 0);
    assert.match(absent.out, /lock install: absent/);

    acquireLock({ dir, name: "install", task: "v3", pid: 4242, host: "host-a", clock: CLOCK });
    const held = capture(() => runLock(["status", "install", "--json"], { locksDir: dir }));
    assert.equal(held.code, 0);
    assert.deepEqual(JSON.parse(held.out), {
      name: "install",
      state: "held",
      path: lockPath(dir, "install"),
      owner: { name: "install", pid: 4242, host: "host-a", task: "v3", at: FIXED_AT },
    });

    writeFileSync(lockPath(dir, "install"), "{}");
    const broken = capture(() => runLock(["status", "install"], { locksDir: dir }));
    assert.equal(broken.code, 1, "an unreadable lock is a fault, not a state to trust");
    assert.match(broken.out, /unreadable/);
  });
});

test("lock release removes the lock and reports an absent one", async () => {
  await withTempDir((dir) => {
    acquireLock({ dir, name: "install", pid: 4242, host: "host-a", clock: CLOCK });
    const released = capture(() => runLock(["release", "install"], { locksDir: dir, pid: 4242 }));
    assert.equal(released.code, 0);
    assert.match(released.out, /lock install: released/);

    const again = capture(() => runLock(["release", "install"], { locksDir: dir, pid: 4242 }));
    assert.equal(again.code, 0);
    assert.match(again.out, /lock install: absent/);
  });
});

test("lock refuses bad usage with exit 2", async () => {
  await withTempDir((dir) => {
    const cases = [
      [[], /missing <hold\|status\|release>/],
      [["bogus", "x"], /unknown verb/],
      [["status"], /missing <name>/],
      [["hold", "x"], /hold requires a command after --/],
      [["status", "x", "--nope"], /unknown option/],
      [["status", "x", "--locks-dir"], /--locks-dir requires a value/],
      [["status", "Bad"], /not a valid lock name/],
      [["release", "x", "--", "ls"], /release takes no command/],
    ];
    for (const [args, pattern] of cases) {
      const result = capture(() => runLock(args, { locksDir: dir }));
      assert.equal(result.code, 2, `expected exit 2 for ${args.join(" ")}: ${result.err}`);
      assert.match(result.err, pattern);
    }
  });
});

test("describeHolder names the pid, host, task and time", () => {
  const described = describeHolder({ pid: 7, host: "h", task: "t", at: FIXED_AT });
  assert.equal(described, `pid 7 on h task t since ${FIXED_AT}`);
  assert.equal(
    describeHolder({ pid: 7, host: "h", task: null, at: FIXED_AT }),
    `pid 7 on h since ${FIXED_AT}`,
  );
});

test("the CLI dispatches the lock and schedule commands through scripts/yukl.js", async () => {
  for (const name of ["lock", "schedule"]) {
    const dispatched = await dispatchCommand(name, []);
    assert.equal(dispatched, 2, `${name} is discoverable and reports a usage problem`);
  }
});
