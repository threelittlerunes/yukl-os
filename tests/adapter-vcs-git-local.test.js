import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVcs, runHeadTrailer } from "../scripts/adapters/vcs-git-local.js";

const GREEN = 'node -e "process.exit(0)"';
const RED = 'node -e "process.exit(1)"';
const RED_THREE = 'node -e "process.exit(3)"';

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-vcs-test-"));
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

/**
 * A temp repository with a `main` base branch and a `feature` branch one
 * commit ahead. `main` is checked out when the callback runs.
 */
async function withRepo(fn) {
  return withTempDir(async (dir) => {
    git(["-c", "init.defaultBranch=main", "init", "-q"], dir);
    git(["config", "user.name", "Yukl Test"], dir);
    git(["config", "user.email", "yukl-test@example.invalid"], dir);
    writeFileSync(join(dir, "base.txt"), "base\n");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    git(["checkout", "-q", "-b", "feature"], dir);
    writeFileSync(join(dir, "feature.txt"), "feature\n");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "feature"], dir);
    git(["checkout", "-q", "main"], dir);
    return fn(dir);
  });
}

// ---------------------------------------------------------------------------
// runHeadTrailer
// ---------------------------------------------------------------------------

test("runHeadTrailer renders the trailer string", () => {
  assert.equal(
    runHeadTrailer({ taskId: "task-xyz", hash: "abc123" }),
    "Yukl-Run-Head: task-xyz abc123",
  );
});

test("runHeadTrailer throws when taskId or hash is missing or empty", () => {
  for (const bad of [
    {},
    { taskId: "task" },
    { hash: "abc" },
    { taskId: "", hash: "abc" },
    { taskId: "task", hash: "  " },
    { taskId: "   ", hash: "abc" },
    null,
    undefined,
  ]) {
    assert.throws(() => runHeadTrailer(bad), /non-empty taskId and hash/);
  }
});

// ---------------------------------------------------------------------------
// createVcs shape
// ---------------------------------------------------------------------------

test("createVcs returns the shared adapter shape", () => {
  const vcs = createVcs({ repoDir: process.cwd(), commands: [GREEN] });
  assert.equal(vcs.name, "vcs-git-local");
  assert.equal(typeof vcs.checks, "function");
  assert.equal(typeof vcs.merge, "function");
});

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

test("checks runs the proof commands and reports a green exit code", async () => {
  await withRepo(async (dir) => {
    const vcs = createVcs({ repoDir: dir, commands: [GREEN, GREEN] });
    const result = await vcs.checks("feature");
    assert.equal(result.ok, true);
    assert.deepEqual(result.results, [
      { command: GREEN, exitCode: 0 },
      { command: GREEN, exitCode: 0 },
    ]);

    const worktrees = git(["worktree", "list", "--porcelain"], dir)
      .stdout.split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "));
    assert.equal(worktrees.length, 1, "the temporary worktree is removed afterwards");
  });
});

test("checks reports a failing exit code and is not ok", async () => {
  await withRepo(async (dir) => {
    const vcs = createVcs({ repoDir: dir, commands: [GREEN, RED_THREE] });
    const result = await vcs.checks("feature");
    assert.equal(result.ok, false);
    assert.deepEqual(result.results, [
      { command: GREEN, exitCode: 0 },
      { command: RED_THREE, exitCode: 3 },
    ]);
  });
});

test("checks refuses an unknown ref without leaving a worktree behind", async () => {
  await withRepo(async (dir) => {
    const vcs = createVcs({ repoDir: dir, commands: [GREEN] });
    const result = await vcs.checks("no-such-ref");
    assert.equal(result.ok, false);
    assert.deepEqual(result.results, []);
    const worktrees = git(["worktree", "list", "--porcelain"], dir)
      .stdout.split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "));
    assert.equal(worktrees.length, 1);
  });
});

// ---------------------------------------------------------------------------
// checks default commands from the base config
// ---------------------------------------------------------------------------

test("createVcs defaults commands from yukl.config.json at the base ref", async () => {
  await withRepo(async (dir) => {
    writeFileSync(
      join(dir, "yukl.config.json"),
      JSON.stringify({
        version: 1,
        commands: { build: null, test: null, format: null },
        folders: {
          contracts: ".orchestration/contracts",
          intents: ".orchestration/intents",
          locks: ".orchestration/locks",
          artifacts: ".orchestration/artifacts",
        },
        allowlist: [GREEN],
      }),
    );
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "add config"], dir);

    const vcs = createVcs({ repoDir: dir });
    const result = await vcs.checks("feature");
    assert.equal(result.ok, true);
    assert.deepEqual(result.results, [{ command: GREEN, exitCode: 0 }]);
  });
});

test("createVcs throws when no commands are given and the base has no config", async () => {
  await withRepo(async (dir) => {
    assert.throws(() => createVcs({ repoDir: dir }), /cannot resolve proof commands/);
  });
});

// ---------------------------------------------------------------------------
// merge control
// ---------------------------------------------------------------------------

test("merge advances the base and records the run-head trailer", async () => {
  await withRepo(async (dir) => {
    const vcs = createVcs({ repoDir: dir, commands: [GREEN] });
    const before = git(["rev-parse", "main"], dir).stdout.trim();

    const result = await vcs.merge("feature", "main", {
      runHead: { taskId: "task-xyz", hash: "abc123" },
    });
    assert.equal(result.ok, true);
    assert.match(result.sha, /^[0-9a-f]{40}$/);
    assert.notEqual(result.sha, before);

    assert.equal(git(["rev-parse", "main"], dir).stdout.trim(), result.sha);
    const message = git(["log", "-1", "--format=%B", "main"], dir).stdout;
    assert.match(message, /Yukl-Run-Head: task-xyz abc123/);
    assert.equal(git(["show", "main:feature.txt"], dir).stdout.trim(), "feature");
  });
});

// ---------------------------------------------------------------------------
// merge must-reject
// ---------------------------------------------------------------------------

test("merge refuses when a proof command fails and leaves base unchanged", async () => {
  await withRepo(async (dir) => {
    const vcs = createVcs({ repoDir: dir, commands: [RED] });
    const before = git(["rev-parse", "main"], dir).stdout.trim();

    const result = await vcs.merge("feature", "main", {
      runHead: { taskId: "task-xyz", hash: "abc123" },
    });
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, "sha"), false);
    assert.equal(git(["rev-parse", "main"], dir).stdout.trim(), before);
  });
});

test("merge refuses an incomplete run head and leaves base unchanged", async () => {
  await withRepo(async (dir) => {
    const vcs = createVcs({ repoDir: dir, commands: [GREEN] });
    const before = git(["rev-parse", "main"], dir).stdout.trim();

    for (const runHead of [
      { hash: "abc123" },
      { taskId: "task-xyz" },
      { taskId: "", hash: "abc" },
    ]) {
      const result = await vcs.merge("feature", "main", { runHead });
      assert.equal(result.ok, false);
      assert.equal(typeof result.error, "string");
    }
    assert.equal(git(["rev-parse", "main"], dir).stdout.trim(), before);
  });
});
