import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createVcs, runHeadTrailer } from "../scripts/adapters/vcs-github.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_GH = join(HERE, "fixtures", "fake-gh", "fake-gh.js");

const FORBIDDEN_FLAGS = ["--admin", "--squash", "--rebase", "--auto"];

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-vcs-github-"));
  try {
    return await fn(dir);
  } finally {
    // A force-killed command tree can hold the directory briefly on Windows.
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
 * Run `fn` against an adapter pointed at the fake CLI, with `scenario` written
 * to the directory named by FAKE_GH_SCENARIO. The fake appends its argv to the
 * log file under the same directory; the path comes back as `logPath`.
 */
async function withFakeGh(scenario, fn) {
  await withTempDir(async (dir) => {
    const scenarioPath = join(dir, "scenario.json");
    writeFileSync(scenarioPath, JSON.stringify(scenario));
    const logPath = join(dir, "gh.log");
    process.env.FAKE_GH_SCENARIO = scenarioPath;
    process.env.FAKE_GH_LOG = logPath;
    try {
      const vcs = createVcs({ gh: [process.execPath, FAKE_GH], cwd: dir });
      await fn({ vcs, logPath });
    } finally {
      delete process.env.FAKE_GH_SCENARIO;
      delete process.env.FAKE_GH_LOG;
    }
  });
}

function allPassScenario(overrides = {}) {
  return {
    "pr checks": {
      exitCode: 0,
      stdout: JSON.stringify([{ name: "build", state: "SUCCESS" }]),
    },
    "pr view": { exitCode: 0, stdout: JSON.stringify({ baseRefName: "main" }) },
    "pr merge": { exitCode: 0, stdout: "" },
    ...overrides,
  };
}

function readLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function mergeCalls(log) {
  return log.filter((argv) => argv[0] === "pr" && argv[1] === "merge");
}

const RUN_HEAD = { taskId: "v2-w2-vcs-github", hash: "c0ffee" };

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

test("createVcs returns an async checks/merge adapter named github", () => {
  const vcs = createVcs({ gh: "gh", cwd: process.cwd() });
  assert.equal(vcs.name, "github");
  assert.equal(typeof vcs.checks, "function");
  assert.equal(typeof vcs.merge, "function");
  assert.equal(vcs.checks.constructor.name, "AsyncFunction");
  assert.equal(vcs.merge.constructor.name, "AsyncFunction");
});

test("runHeadTrailer renders the trailer and throws on a missing part", () => {
  assert.equal(runHeadTrailer(RUN_HEAD), "Yukl-Run-Head: v2-w2-vcs-github c0ffee");
  for (const bad of [
    {},
    { taskId: "t" },
    { hash: "h" },
    { taskId: "", hash: "h" },
    { taskId: "t", hash: " " },
    { taskId: "   ", hash: "h" },
  ]) {
    assert.throws(() => runHeadTrailer(bad));
  }
});

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

test("checks is ok when every required check is a pass (case-insensitive)", async () => {
  const scenario = {
    "pr checks": {
      exitCode: 0,
      stdout: JSON.stringify([
        { name: "build", state: "SUCCESS" },
        { name: "lint", state: "pass" },
      ]),
    },
  };
  await withFakeGh(scenario, async ({ vcs }) => {
    const outcome = await vcs.checks("42");
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.results, [
      { name: "build", state: "SUCCESS" },
      { name: "lint", state: "pass" },
    ]);
  });
});

test("checks is not ok when a required check is pending", async () => {
  const scenario = {
    "pr checks": {
      exitCode: 1,
      stdout: JSON.stringify([
        { name: "build", state: "SUCCESS" },
        { name: "test", state: "PENDING" },
      ]),
    },
  };
  await withFakeGh(scenario, async ({ vcs }) => {
    const outcome = await vcs.checks("42");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.results.length, 2);
  });
});

test("checks is not ok when the required check list is empty", async () => {
  const scenario = { "pr checks": { exitCode: 0, stdout: "[]" } };
  await withFakeGh(scenario, async ({ vcs }) => {
    const outcome = await vcs.checks("42");
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.results, []);
  });
});

// ---------------------------------------------------------------------------
// merge: control
// ---------------------------------------------------------------------------

test("merge merges once with the run-head trailer when checks pass and the base matches", async () => {
  await withFakeGh(allPassScenario(), async ({ vcs, logPath }) => {
    const outcome = await vcs.merge("42", "main", { runHead: RUN_HEAD });
    assert.equal(outcome.ok, true);

    const merges = mergeCalls(readLog(logPath));
    assert.equal(merges.length, 1);
    const argv = merges[0];
    assert.ok(argv.includes("--merge"), "the merge uses --merge");
    const bodyIndex = argv.indexOf("--body");
    assert.ok(bodyIndex > -1, "the merge carries a body");
    assert.match(argv[bodyIndex + 1], /^Yukl-Run-Head: v2-w2-vcs-github c0ffee$/);
  });
});

test("the recorded gh argv never asks for an admin, squash, rebase or auto merge", async () => {
  await withFakeGh(allPassScenario(), async ({ vcs, logPath }) => {
    const outcome = await vcs.merge("42", "main", { runHead: RUN_HEAD });
    assert.equal(outcome.ok, true);
    assert.equal(mergeCalls(readLog(logPath)).length, 1);
    for (const argv of readLog(logPath)) {
      for (const flag of FORBIDDEN_FLAGS) {
        assert.ok(!argv.includes(flag), `argv must not contain ${flag}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// merge: must-reject
// ---------------------------------------------------------------------------

test("merge refuses without merging when a required check is not passing", async () => {
  const scenario = allPassScenario({
    "pr checks": {
      exitCode: 1,
      stdout: JSON.stringify([{ name: "build", state: "FAILURE" }]),
    },
  });
  await withFakeGh(scenario, async ({ vcs, logPath }) => {
    const outcome = await vcs.merge("42", "main", { runHead: RUN_HEAD });
    assert.equal(outcome.ok, false);
    assert.equal(mergeCalls(readLog(logPath)).length, 0);
  });
});

test("merge refuses and records nothing when the run head has no taskId", async () => {
  await withFakeGh(allPassScenario(), async ({ vcs, logPath }) => {
    const outcome = await vcs.merge("42", "main", { runHead: { hash: "c0ffee" } });
    assert.equal(outcome.ok, false);
    assert.deepEqual(readLog(logPath), []);
  });
});

test("merge refuses without merging when the base does not match the pull request", async () => {
  await withFakeGh(allPassScenario(), async ({ vcs, logPath }) => {
    const outcome = await vcs.merge("42", "release", { runHead: RUN_HEAD });
    assert.equal(outcome.ok, false);
    assert.equal(mergeCalls(readLog(logPath)).length, 0);
  });
});

test("merge reports failure when the merge command itself fails", async () => {
  const scenario = allPassScenario({
    "pr merge": { exitCode: 1, stderr: "protected branch" },
  });
  await withFakeGh(scenario, async ({ vcs, logPath }) => {
    const outcome = await vcs.merge("42", "main", { runHead: RUN_HEAD });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /protected branch/);
    assert.equal(mergeCalls(readLog(logPath)).length, 1);
  });
});
