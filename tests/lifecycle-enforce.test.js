import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathEnforcement } from "../scripts/lifecycle/enforce.js";

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

async function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-enforce-"));
  try {
    git(["-c", "init.defaultBranch=main", "init", "-q"], dir);
    git(["config", "user.name", "Yukl Test"], dir);
    git(["config", "user.email", "yukl-test@example.com"], dir);
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

function writeTreeFile(dir, relPath, content = "x") {
  mkdirSync(join(dir, dirname(relPath)), { recursive: true });
  writeFileSync(join(dir, relPath), content);
}

function writeIntent(dir, { allowedPaths, forbiddenPaths = [], taskId = "demo" }) {
  mkdirSync(join(dir, ".orchestration", "intents"), { recursive: true });
  const lines = [
    "intent:",
    '  goal: "A trivial lifecycle enforcement task."',
    "  scope:",
    "    allowed_paths:",
    ...allowedPaths.map((p) => `      - "${p}"`),
  ];
  if (forbiddenPaths.length > 0) {
    lines.push("    forbidden_paths:");
    for (const p of forbiddenPaths) lines.push(`      - "${p}"`);
  }
  lines.push("consultation:", "  requires_human_approval: false", "");
  writeFileSync(join(dir, ".orchestration", "intents", `${taskId}.yml`), lines.join("\n"));
}

// ---------------------------------------------------------------------------
// control: an in-scope branch passes
// ---------------------------------------------------------------------------

test("pathEnforcement accepts an in-scope branch (known-good control)", async () => {
  await withTempRepo(async (dir) => {
    writeIntent(dir, { allowedPaths: ["src/allowed/**"] });
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    git(["checkout", "-q", "-b", "feature"], dir);

    writeTreeFile(dir, "src/allowed/a.js");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "in scope"], dir);

    const result = pathEnforcement({
      cwd: dir,
      base: "main",
      branch: "feature",
      taskId: "demo",
    });
    assert.deepEqual(result.violations, []);
    assert.equal(result.ok, true);
    assert.equal(result.rule, "R-PATH-SCOPE");
  });
});

// ---------------------------------------------------------------------------
// must-reject: a branch outside the intent's allowed_paths
// ---------------------------------------------------------------------------

test("pathEnforcement rejects a branch that adds a file outside allowed_paths (known-bad control)", async () => {
  await withTempRepo(async (dir) => {
    writeIntent(dir, { allowedPaths: ["src/allowed/**"] });
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    git(["checkout", "-q", "-b", "feature"], dir);

    writeTreeFile(dir, "src/other.js");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "out of scope"], dir);

    const result = pathEnforcement({
      cwd: dir,
      base: "main",
      branch: "feature",
      taskId: "demo",
    });
    assert.equal(result.ok, false);
    assert.equal(result.rule, "R-PATH-SCOPE");
    assert.ok(
      result.violations.some((v) => /src\/other\.js matches no allowed_paths/.test(v)),
      `the violating file must be named; got ${JSON.stringify(result.violations)}`,
    );
  });
});

test("pathEnforcement rejects a file matching forbidden_paths even when allowed", async () => {
  await withTempRepo(async (dir) => {
    writeIntent(dir, { allowedPaths: ["src/**"], forbiddenPaths: ["src/secret/**"] });
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    git(["checkout", "-q", "-b", "feature"], dir);

    writeTreeFile(dir, "src/secret/x.js");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "forbidden"], dir);

    const result = pathEnforcement({
      cwd: dir,
      base: "main",
      branch: "feature",
      taskId: "demo",
    });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => /src\/secret\/x\.js matches forbidden_paths/.test(v)));
  });
});

// ---------------------------------------------------------------------------
// must-reject: the intent must exist at the base, not only on the branch
// ---------------------------------------------------------------------------

test("pathEnforcement rejects an intent that exists only on the branch", async () => {
  await withTempRepo(async (dir) => {
    writeTreeFile(dir, "README.md", "base\n");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    git(["checkout", "-q", "-b", "feature"], dir);

    writeIntent(dir, { allowedPaths: ["src/allowed/**"] });
    writeTreeFile(dir, "src/allowed/a.js");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "intent plus code"], dir);

    const result = pathEnforcement({
      cwd: dir,
      base: "main",
      branch: "feature",
      taskId: "demo",
    });
    assert.equal(result.ok, false);
    assert.equal(result.rule, "R-PATH-SCOPE");
    assert.ok(
      result.violations.some((v) => /intent for demo not found at main/.test(v)),
      `the unresolved intent must be reported; got ${JSON.stringify(result.violations)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// fail closed on incomplete input
// ---------------------------------------------------------------------------

test("pathEnforcement fails closed when base or branch is missing", async () => {
  const result = pathEnforcement({ cwd: process.cwd(), taskId: "demo" });
  assert.equal(result.ok, false);
  assert.equal(result.rule, "R-PATH-SCOPE");
  assert.ok(result.violations.some((v) => /base and branch are required/.test(v)));
});
