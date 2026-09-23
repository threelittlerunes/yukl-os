import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, headHash, readEvents } from "../scripts/lifecycle/events.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const YUKL = join(ROOT, "scripts", "yukl.js");
const TASK = "task-status";
const ANCHOR = "a".repeat(40);

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-status-"));
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

/** Run git with an argument array and assert it succeeded. */
function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

/** A temp repository whose main branch holds one commit. */
async function withRepo(fn) {
  return withTempDir(async (dir) => {
    git(["-c", "init.defaultBranch=main", "init", "-q"], dir);
    git(["config", "user.name", "Yukl Test"], dir);
    git(["config", "user.email", "yukl-test@example.invalid"], dir);
    writeFileSync(join(dir, "base.txt"), "base\n");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    return fn(dir);
  });
}

/** Commit an empty commit whose body carries a run-head trailer. */
function commitTrailer(dir, taskId, hash, subject = "Merge feature into main") {
  git(
    ["commit", "-q", "--allow-empty", "-m", subject, "-m", `Yukl-Run-Head: ${taskId} ${hash}`],
    dir,
  );
}

/** Spawn `yukl status` with the given raw arguments from `cwd`. */
function runCli(args, cwd) {
  return spawnSync(process.execPath, [YUKL, "status", ...args], { cwd, encoding: "utf8" });
}

/** A three-event log: a stage move, a decision and a retry attempt. */
function seedLog(stateDir, actor = "drafter") {
  appendEvent(stateDir, TASK, {
    type: "stage_done",
    actor,
    anchor: { path: "intent.md", commit: ANCHOR },
    data: { to: "implement" },
  });
  appendEvent(stateDir, TASK, {
    type: "decision",
    actor: "engine",
    decision: { kind: "deterministic", rule: "R-NO-ANCHOR", rationale: "no anchor" },
    data: { attempt: 1 },
  });
  appendEvent(stateDir, TASK, { type: "attempt", actor, data: {} });
}

function logPathOf(stateDir) {
  return join(stateDir, `${TASK}.jsonl`);
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

test("an untouched log with a committed head exits 0 and reports its uncommitted tail", async () => {
  await withRepo(async (dir) => {
    const stateDir = join(dir, "state");
    appendEvent(stateDir, TASK, {
      type: "stage_done",
      actor: "drafter",
      anchor: { path: "intent.md", commit: ANCHOR },
      data: { to: "implement" },
    });
    appendEvent(stateDir, TASK, {
      type: "decision",
      actor: "engine",
      decision: { kind: "deterministic", rule: "R-NO-ANCHOR", rationale: "no anchor" },
      data: { attempt: 1 },
    });
    const committed = headHash(readEvents(stateDir, TASK));
    commitTrailer(dir, TASK, committed);
    appendEvent(stateDir, TASK, { type: "attempt", actor: "drafter", data: {} });

    // No --base: the default main branch must be used.
    const result = runCli([TASK, "--state-dir", stateDir], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /task: task-status/);
    assert.match(result.stdout, /state: stage=implement attempts=1 events=3/);
    assert.match(result.stdout, /last decision: rule R-NO-ANCHOR/);
    assert.match(result.stdout, /chain: ok/);
    assert.match(result.stdout, /committed head: [0-9a-f]{64}/);
    assert.match(result.stdout, /head: found at event 1/);
    assert.match(result.stdout, /uncommitted tail: 1 event/);
    assert.match(result.stdout, /not verified/);
  });
});

test("an adaptive decision is reported by its rationale", async () => {
  await withRepo(async (dir) => {
    const stateDir = join(dir, "state");
    appendEvent(stateDir, TASK, {
      type: "decision",
      actor: "engine",
      decision: {
        kind: "adaptive",
        tactic: "rational persuasion",
        rationale: "re-run the failing proof with its captured output",
      },
      data: {},
    });

    const result = runCli([TASK, "--state-dir", stateDir, "--base", "main"], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /last decision: rationale re-run the failing proof/);
  });
});

test("a human decision is reported by its decision and reason", async () => {
  await withRepo(async (dir) => {
    const stateDir = join(dir, "state");
    appendEvent(stateDir, TASK, {
      type: "human_decision",
      actor: "human:alice",
      data: { decision: "pause", reason: "hold" },
    });

    const result = runCli([TASK, "--state-dir", stateDir, "--base", "main"], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /last decision: human pause \(hold\)/);
  });
});

test("when the base carries no trailer for the task the chain alone decides", async () => {
  await withRepo(async (dir) => {
    const stateDir = join(dir, "state");
    seedLog(stateDir);

    const result = runCli([TASK, "--state-dir", stateDir, "--base", "main"], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /chain: ok/);
    assert.match(result.stdout, /committed head: none for this task on main/);
  });
});

// ---------------------------------------------------------------------------
// must-reject cases
// ---------------------------------------------------------------------------

test("a missing log exits 1 with a clear message", async () => {
  await withTempDir(async (dir) => {
    const result = runCli([TASK, "--state-dir", join(dir, "state"), "--base", "main"], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no event log for task task-status/);
  });
});

test("a tampered log exits 1 naming the line", async () => {
  await withRepo(async (dir) => {
    const stateDir = join(dir, "state");
    seedLog(stateDir);
    commitTrailer(dir, TASK, headHash(readEvents(stateDir, TASK)));

    const lines = readFileSync(logPathOf(stateDir), "utf8").split("\n").filter(Boolean);
    lines[1] = lines[1].replace('"actor":"engine"', '"actor":"tampered"');
    assert.ok(lines[1].includes("tampered"), "the middle line must actually change");
    writeFileSync(logPathOf(stateDir), `${lines.join("\n")}\n`);

    const result = runCli([TASK, "--state-dir", stateDir, "--base", "main"], dir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /chain: broken at line 2/);
    assert.match(result.stderr, /line 2/);
  });
});

test("a fully rewritten log exits 1 against the committed head", async () => {
  await withRepo(async (dir) => {
    const stateDir = join(dir, "state");
    seedLog(stateDir);
    const committed = headHash(readEvents(stateDir, TASK));
    commitTrailer(dir, TASK, committed);

    await withTempDir(async (other) => {
      seedLog(other, "rewriter");
      writeFileSync(logPathOf(stateDir), readFileSync(logPathOf(other), "utf8"));
    });

    const result = runCli([TASK, "--state-dir", stateDir, "--base", "main"], dir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /chain: ok/, "the rewritten chain is internally consistent");
    assert.match(result.stdout, /head: not found/);
    assert.match(
      result.stderr,
      new RegExp(`no line in the log hashes to the committed head ${committed}`),
    );
  });
});

test("a newer trailer for a different task is ignored", async () => {
  await withRepo(async (dir) => {
    const stateDir = join(dir, "state");
    appendEvent(stateDir, TASK, {
      type: "stage_done",
      actor: "drafter",
      anchor: { path: "intent.md", commit: ANCHOR },
      data: { to: "implement" },
    });
    appendEvent(stateDir, TASK, { type: "attempt", actor: "drafter", data: {} });
    const committed = headHash(readEvents(stateDir, TASK));
    commitTrailer(dir, TASK, committed);
    commitTrailer(dir, "other-task", "f".repeat(64), "Merge the other feature");

    const result = runCli([TASK, "--state-dir", stateDir, "--base", "main"], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(`committed head: ${committed}`),
      "the older trailer wins",
    );
    assert.match(result.stdout, /uncommitted tail: 0 event/);
  });
});

test("an unreadable base exits 1 with a clear message", async () => {
  await withRepo(async (dir) => {
    const stateDir = join(dir, "state");
    seedLog(stateDir);

    const result = runCli([TASK, "--state-dir", stateDir, "--base", "no-such-branch"], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot read trailers from no-such-branch/);
  });
});

// ---------------------------------------------------------------------------
// usage errors (exit 2)
// ---------------------------------------------------------------------------

test("bad usage exits 2", () => {
  const cases = [
    [[], /missing task id/],
    [["--state-dir", "x"], /missing task id/],
    [[TASK, "--bogus"], /unknown option/],
    [[TASK, "extra"], /unexpected argument/],
    [[TASK, "--state-dir"], /missing value for --state-dir/],
    [[TASK, "--base"], /missing value for --base/],
    [["Bad/Id", "--base", "main"], /invalid task id/],
  ];
  for (const [args, pattern] of cases) {
    const result = runCli(args, ROOT);
    assert.equal(result.status, 2, `expected exit 2 for ${args.join(" ")}`);
    assert.match(result.stderr, pattern);
  }
});
