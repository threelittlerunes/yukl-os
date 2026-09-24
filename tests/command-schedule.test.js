import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planWaves,
  readIntentScope,
  run as runSchedule,
  runArguments,
  scopePrefix,
  scopesOverlap,
  tasksOverlap,
} from "../scripts/commands/schedule.js";
import { acquireLock, inspectLock } from "../scripts/lifecycle/locks.js";

const FIXED_AT = "2026-01-01T00:00:00.000Z";
const CLOCK = () => new Date(FIXED_AT);
const GIT_IDENTITY = ["-c", "user.email=yukl-test@example.invalid", "-c", "user.name=Yukl Test"];

/** Run git in a temp repo, throwing on failure. */
function git(args, cwd) {
  const result = spawnSync("git", [...GIT_IDENTITY, ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/** Write a task intent carrying `allowedPaths`, as the repo's intents do. */
function writeIntent(dir, taskId, allowedPaths) {
  const intents = join(dir, ".orchestration", "intents");
  mkdirSync(intents, { recursive: true });
  writeFileSync(
    join(intents, `${taskId}.yml`),
    `intent:\n  scope:\n    allowed_paths:\n${allowedPaths.map((p) => `      - "${p}"`).join("\n")}\n`,
  );
}

/** Commit the whole working tree, so `HEAD` has the intents written so far. */
function commitAll(dir) {
  git(["init", "-q"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "seed intents"], dir);
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-schedule-"));
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

/** Capture console output around an async call. */
async function capture(fn) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args) => out.push(args.join(" "));
  console.error = (...args) => err.push(args.join(" "));
  try {
    const code = await fn();
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** A task scope judgement over plain allowed_paths lists. */
function task(taskId, allowedPaths = null) {
  return { taskId, allowedPaths };
}

// ---------------------------------------------------------------------------
// scope prefixes and overlap (pure functions)
// ---------------------------------------------------------------------------

test("scopePrefix reduces a pattern to the directory it scopes", () => {
  assert.equal(scopePrefix("scripts/**"), "scripts");
  assert.equal(scopePrefix("scripts/*.js"), "scripts");
  assert.equal(scopePrefix("scripts/lifecycle/*.js"), "scripts/lifecycle");
  assert.equal(scopePrefix("./tests/**/x.js"), "tests");
  assert.equal(scopePrefix("docs\\YUKL_ARCHITECTURE.md"), "docs/YUKL_ARCHITECTURE.md");
  assert.equal(scopePrefix("**"), "");
  assert.equal(scopePrefix("scripts/"), "scripts");
});

test("scopesOverlap serialises a scope that contains another and clears disjoint ones", () => {
  assert.equal(scopesOverlap("scripts/**", "scripts/lifecycle/limits.js"), true);
  assert.equal(scopesOverlap("scripts/**", "scripts/*.js"), true);
  assert.equal(scopesOverlap("docs/a.md", "docs/b.md"), false);
  assert.equal(scopesOverlap("scripts/**", "tests/**"), false);
  assert.equal(scopesOverlap("docs/**", "docs/YUKL_ARCHITECTURE.md"), true);
  assert.equal(scopesOverlap("**", "tests/**"), true, "a whole-repo scope overlaps everything");
  assert.equal(scopesOverlap("src/api/**", "src/api/**"), true);
  assert.equal(
    scopesOverlap("src/api/**", "src/apis/**"),
    false,
    "a prefix must end at a boundary",
  );
});

test("a task with no readable scope overlaps everything, so it runs alone", () => {
  assert.equal(tasksOverlap(task("a", ["scripts/**"]), task("b", ["tests/**"])), false);
  assert.equal(tasksOverlap(task("a", ["scripts/**"]), task("b", ["scripts/lifecycle/**"])), true);
  for (const unknown of [task("b"), task("b", []), task("b", "scripts/**")]) {
    assert.equal(tasksOverlap(task("a", ["scripts/**"]), unknown), true);
    assert.equal(tasksOverlap(unknown, task("a", ["scripts/**"])), true);
  }
});

// ---------------------------------------------------------------------------
// wave planning (pure function)
// ---------------------------------------------------------------------------

test("planWaves packs non-overlapping tasks and serialises overlapping ones", () => {
  const waves = planWaves([
    task("alpha", ["scripts/**"]),
    task("beta", ["tests/**"]),
    task("gamma", ["scripts/lifecycle/**"]),
    task("delta", ["docs/**"]),
  ]);
  assert.deepEqual(
    waves.map((wave) => wave.map((entry) => entry.taskId)),
    [["alpha", "beta", "delta"], ["gamma"]],
    "gamma overlaps alpha, so it waits for the wave alpha is in",
  );
});

test("planWaves keeps the given order and opens a wave per unknown scope", () => {
  const waves = planWaves([
    task("mystery"),
    task("alpha", ["scripts/**"]),
    task("beta", ["tests/**"]),
  ]);
  assert.deepEqual(
    waves.map((wave) => wave.map((entry) => entry.taskId)),
    [["mystery"], ["alpha", "beta"]],
  );

  assert.deepEqual(
    planWaves([task("solo", ["scripts/**"])]).map((wave) => wave.length),
    [1],
  );
});

// ---------------------------------------------------------------------------
// intent reading
// ---------------------------------------------------------------------------

test("readIntentScope reads intent.scope.allowed_paths and fails closed", async () => {
  await withTempDir((dir) => {
    const intents = join(dir, ".orchestration", "intents");
    mkdirSync(intents, { recursive: true });
    writeFileSync(
      join(intents, "good.yml"),
      'intent:\n  scope:\n    allowed_paths:\n      - "scripts/**"\n      - "tests/**"\n',
    );
    assert.deepEqual(readIntentScope(dir, "good"), ["scripts/**", "tests/**"]);

    writeFileSync(join(intents, "empty.yml"), "intent:\n  goal: nothing\n");
    assert.equal(readIntentScope(dir, "empty.yml"), null);
    assert.equal(readIntentScope(dir, "empty"), null, "a missing intent has no scope");

    writeFileSync(join(intents, "bad.yml"), "intent: [unclosed\n");
    assert.equal(readIntentScope(dir, "bad"), null, "an unparseable intent has no scope");

    writeFileSync(
      join(intents, "entries.yml"),
      "intent:\n  scope:\n    allowed_paths:\n      - 7\n",
    );
    assert.equal(readIntentScope(dir, "entries"), null, "a non-string entry has no scope");
  });
});

test("readIntentScope reads the intent from --base and not from a widened working tree", async () => {
  await withTempDir((dir) => {
    writeIntent(dir, "task-a", ["tests/**"]);
    commitAll(dir);
    // A task branch that rewrites its own intent in the working tree to widen
    // its scope must not widen the scope the scheduler reads.
    writeIntent(dir, "task-a", ["**"]);

    assert.deepEqual(
      readIntentScope(dir, "task-a", "HEAD"),
      ["tests/**"],
      "with --base the committed intent wins",
    );
    assert.deepEqual(
      readIntentScope(dir, "task-a"),
      ["**"],
      "without --base the working tree is read, as a local preview",
    );
    assert.equal(readIntentScope(dir, "task-b", "HEAD"), null, "an intent absent at base has none");
  });
});

test("schedule reads each task's scope from --base, so a branch cannot widen its own", async () => {
  await withTempDir(async (dir) => {
    writeIntent(dir, "alpha", ["tests/**"]);
    writeIntent(dir, "beta", ["scripts/**"]);
    commitAll(dir);
    writeIntent(dir, "alpha", ["scripts/**"]);

    // Committed, alpha and beta cannot overlap, so they share a wave. The
    // working-tree edit would put alpha in beta's scope and serialise them.
    const committed = await capture(() =>
      runSchedule(["alpha", "beta", "--base", "HEAD"], harness(dir, [], { scopes: {} })),
    );
    assert.equal(committed.code, 0, committed.err);
    assert.match(committed.out, /schedule: wave alpha beta/);

    const preview = await capture(() =>
      runSchedule(["alpha", "beta"], harness(dir, [], { scopes: {} })),
    );
    assert.equal(preview.code, 0, preview.err);
    assert.doesNotMatch(preview.out, /wave alpha beta/, "the edited scope serialises them");
  });
});

// ---------------------------------------------------------------------------
// the run command surface
// ---------------------------------------------------------------------------

test("runArguments is the unattended run of one task in its own worktree", () => {
  assert.deepEqual(runArguments("task-a", "/wt/task-a"), [
    "run",
    "task-a",
    "--unattended",
    "--cwd",
    "/wt/task-a",
  ]);
  assert.deepEqual(runArguments("task-a", "/wt/task-a", "main"), [
    "run",
    "task-a",
    "--unattended",
    "--cwd",
    "/wt/task-a",
    "--base",
    "main",
  ]);
});

// ---------------------------------------------------------------------------
// driving the waves
// ---------------------------------------------------------------------------

/** A scheduler harness: injected scopes, worktree creator and runner. */
function harness(dir, events, overrides = {}) {
  return {
    cwd: dir,
    locksDir: join(dir, "locks"),
    worktreesDir: join(dir, "worktrees"),
    pid: 4242,
    host: "host-a",
    clock: CLOCK,
    alive: () => true,
    scopes: {
      alpha: ["scripts/**"],
      beta: ["tests/**"],
      gamma: ["scripts/lifecycle/**"],
    },
    createWorktree: ({ path, repo, base }) => {
      events.push(`worktree ${path} from ${base ?? "HEAD"} in ${repo}`);
      return { ok: true, reused: false };
    },
    runTask: async ({ taskId, worktree, base }) => {
      events.push(`run ${taskId} in ${worktree} base ${base ?? "none"}`);
      return { ok: true, exitCode: 0, error: null };
    },
    ...overrides,
  };
}

test("schedule runs each task in its own worktree, releasing each lock afterwards", async () => {
  await withTempDir(async (dir) => {
    const events = [];
    const { code, out } = await capture(() => runSchedule(["alpha", "beta"], harness(dir, events)));

    assert.equal(code, 0, out);
    assert.deepEqual(events, [
      `worktree ${join(dir, "worktrees", "alpha")} from HEAD in ${dir}`,
      `run alpha in ${join(dir, "worktrees", "alpha")} base none`,
      `worktree ${join(dir, "worktrees", "beta")} from HEAD in ${dir}`,
      `run beta in ${join(dir, "worktrees", "beta")} base none`,
    ]);
    assert.match(out, /schedule: wave alpha beta/);
    assert.match(out, /schedule: alpha ok/);
    assert.match(out, /schedule: beta ok/);
    assert.deepEqual(
      readdirSync(join(dir, "locks")),
      [],
      "every task's advisory lock is released when it settles",
    );
  });
});

test("schedule runs a wave concurrently and starts the next wave only after it settles", async () => {
  await withTempDir(async (dir) => {
    const events = [];
    const inflight = new Set();
    let peak = 0;
    const runTask = async ({ taskId }) => {
      inflight.add(taskId);
      peak = Math.max(peak, inflight.size);
      events.push(`start ${taskId}`);
      await Promise.resolve();
      inflight.delete(taskId);
      events.push(`end ${taskId}`);
      return { ok: true, exitCode: 0, error: null };
    };

    // gamma overlaps alpha (scripts/lifecycle is under scripts/**), so it is
    // serialised into the second wave; beta shares the first wave with alpha.
    const { code } = await capture(() =>
      runSchedule(["alpha", "beta", "gamma"], harness(dir, events, { runTask })),
    );
    assert.equal(code, 0);
    assert.equal(peak, 2, "the two tasks of the first wave ran at the same time");
    assert.deepEqual(
      events.filter((line) => line.startsWith("start ")),
      ["start alpha", "start beta", "start gamma"],
    );
    const gammaStart = events.indexOf("start gamma");
    assert.ok(events.indexOf("end alpha") < gammaStart, "wave two waits for alpha");
    assert.ok(events.indexOf("end beta") < gammaStart, "wave two waits for beta");
    const gammaWorktree = `worktree ${join(dir, "worktrees", "gamma")} from HEAD in ${dir}`;
    assert.ok(
      events.indexOf(gammaWorktree) < gammaStart,
      "gamma's worktree is prepared before its run",
    );
    assert.ok(
      events.indexOf(gammaWorktree) > events.indexOf("end beta"),
      "gamma's worktree waits for the first wave to settle",
    );
  });
});

test("schedule passes the base ref through to every task", async () => {
  await withTempDir(async (dir) => {
    const events = [];
    const { code } = await capture(() =>
      runSchedule(["alpha", "--base", "main"], harness(dir, events)),
    );
    assert.equal(code, 0);
    assert.deepEqual(events, [
      `worktree ${join(dir, "worktrees", "alpha")} from main in ${dir}`,
      `run alpha in ${join(dir, "worktrees", "alpha")} base main`,
    ]);
  });
});

test("schedule reports a failed task and exits 1 while the others still run", async () => {
  await withTempDir(async (dir) => {
    const events = [];
    const runTask = async ({ taskId }) => {
      events.push(`run ${taskId}`);
      return taskId === "alpha"
        ? { ok: false, exitCode: 1, error: "yukl run: blocked" }
        : { ok: true, exitCode: 0, error: null };
    };
    const { code, out } = await capture(() =>
      runSchedule(["alpha", "beta"], harness(dir, events, { runTask })),
    );
    assert.equal(code, 1);
    assert.match(out, /schedule: alpha failed \(yukl run: blocked\)/);
    assert.match(out, /schedule: beta ok/);
    assert.deepEqual(
      events.filter((line) => line.startsWith("run ")),
      ["run alpha", "run beta"],
      "a failed task does not stop the others in its wave",
    );
  });
});

test("schedule refuses a task whose lock is held and never starts it", async () => {
  await withTempDir(async (dir) => {
    const locksDir = join(dir, "locks");
    acquireLock({
      dir: locksDir,
      name: "beta",
      task: "other-run",
      pid: 999,
      host: "host-b",
      clock: CLOCK,
    });
    const events = [];
    const { code, out } = await capture(() =>
      runSchedule(["alpha", "beta"], harness(dir, events, { locksDir })),
    );

    assert.equal(code, 1);
    assert.match(out, /schedule: beta failed \(lock held \(pid 999\)\)/);
    assert.match(out, /schedule: alpha ok/);
    assert.equal(
      events.some((line) => line.includes("beta")),
      false,
      "a locked task is not started",
    );
    assert.equal(inspectLock(locksDir, "beta").owner.pid, 999, "the other holder keeps its lock");
    assert.deepEqual(readdirSync(locksDir), ["beta.lock"], "alpha's own lock was released");
  });
});

test("schedule reclaims a stale lock and reports a refused worktree", async () => {
  await withTempDir(async (dir) => {
    const locksDir = join(dir, "locks");
    acquireLock({
      dir: locksDir,
      name: "alpha",
      task: "dead",
      pid: 111,
      host: "host-a",
      clock: CLOCK,
    });
    const events = [];
    const { code, out } = await capture(() =>
      runSchedule(["alpha"], harness(dir, events, { locksDir, alive: (pid) => pid !== 111 })),
    );
    assert.equal(code, 0, out);
    assert.deepEqual(events.length, 2);

    const refused = await capture(() =>
      runSchedule(
        ["alpha"],
        harness(dir, events, {
          locksDir,
          createWorktree: () => ({ ok: false, error: "git worktree add HEAD failed" }),
        }),
      ),
    );
    assert.equal(refused.code, 1);
    assert.match(refused.out, /schedule: alpha failed \(git worktree add HEAD failed\)/);
    assert.deepEqual(readdirSync(locksDir), [], "the lock is released even when preparation fails");
  });
});

test("schedule prints its waves and results as JSON when asked", async () => {
  await withTempDir(async (dir) => {
    const events = [];
    const { code, out } = await capture(() =>
      runSchedule(["alpha", "gamma", "--json"], harness(dir, events)),
    );
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out), {
      waves: [["alpha"], ["gamma"]],
      tasks: [
        { taskId: "alpha", ok: true, exitCode: 0, error: null },
        { taskId: "gamma", ok: true, exitCode: 0, error: null },
      ],
    });
  });
});

test("schedule refuses bad usage with exit 2", async () => {
  await withTempDir(async (dir) => {
    const cases = [
      [[], /missing <task_id>/],
      [["Bad/Id"], /must be a lower-case path segment/],
      [["alpha", "alpha"], /was given twice/],
      [["alpha", "--nope"], /unknown option/],
      [["alpha", "--cwd"], /--cwd requires a value/],
    ];
    for (const [args, pattern] of cases) {
      const result = await capture(() => runSchedule(args, harness(dir, [])));
      assert.equal(result.code, 2, `expected exit 2 for ${args.join(" ")}: ${result.err}`);
      assert.match(result.err, pattern);
    }
  });
});
