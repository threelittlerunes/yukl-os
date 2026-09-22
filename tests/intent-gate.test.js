import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkIntentPaths,
  globToRegExp,
  matchesGlob,
  resolveGateConfig,
  runVerify,
  taskIntentViolations,
  yuklConfigViolations,
} from "../scripts/yukl.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const YUKL = join(ROOT, "scripts", "yukl.js");

// ---------------------------------------------------------------------------
// in-house glob matcher
// ---------------------------------------------------------------------------

test("glob: literal paths match exactly", () => {
  assert.equal(matchesGlob("CHANGELOG.md", "CHANGELOG.md"), true);
  assert.equal(matchesGlob("docs/YUKL_ARCHITECTURE.md", "docs/YUKL_ARCHITECTURE.md"), true);
  assert.equal(matchesGlob("CHANGELOG.md", "changelog.md"), false);
  assert.equal(matchesGlob("scripts/yukl.js", "CHANGELOG.md"), false);
});

test("glob: ** crosses segment boundaries (known-good control)", () => {
  assert.equal(matchesGlob("tests/x/y.js", "tests/**"), true);
  assert.equal(matchesGlob("src/a.js", "src/**"), true);
  assert.equal(matchesGlob("tests/a.js", "**"), true);
});

test("glob: * stays inside one segment (known-bad control)", () => {
  assert.equal(matchesGlob("src/a.js", "tests/**"), false);
  assert.equal(matchesGlob("tests/x/y.js", "tests/*.js"), false);
  assert.equal(matchesGlob("tests/a.js", "tests/*.js"), true);
  assert.equal(matchesGlob("tests/x/y.js", "tests/**"), true);
});

test("glob: globToRegExp compiles **/** and mid-pattern ** deterministically", () => {
  assert.equal(globToRegExp("a/**/b").test("a/b"), true);
  assert.equal(globToRegExp("a/**/b").test("a/x/y/b"), true);
  assert.equal(globToRegExp("**/**").test("a/b/c"), true);
});

// ---------------------------------------------------------------------------
// config and intent schemas
// ---------------------------------------------------------------------------

const VALID_CONFIG = {
  version: 1,
  commands: { build: "npm run build", test: "npm run test", format: "npm run format" },
  folders: {
    contracts: ".orchestration/contracts",
    intents: ".orchestration/intents",
    locks: ".orchestration/locks",
    artifacts: ".orchestration/artifacts",
  },
  allowlist: ["npm run build", "npm run test"],
};

const VALID_INTENT = {
  intent: {
    goal: "A trivial task.",
    scope: { allowed_paths: ["tests/**"], forbidden_paths: ["tests/fixtures/**"] },
  },
  consultation: { requires_human_approval: false },
};

test("yuklConfigViolations accepts a valid config", () => {
  assert.deepEqual(yuklConfigViolations(VALID_CONFIG), []);
});

test("yuklConfigViolations rejects a missing or empty allowlist", () => {
  const violations = yuklConfigViolations({ ...VALID_CONFIG, allowlist: [] });
  assert.ok(violations.some((v) => /allowlist must be a non-empty array/.test(v)));
});

test("taskIntentViolations accepts a valid intent", () => {
  assert.deepEqual(taskIntentViolations(VALID_INTENT), []);
});

test("taskIntentViolations rejects an intent without allowed_paths", () => {
  const violations = taskIntentViolations({
    intent: { goal: "x", scope: { allowed_paths: [] } },
    consultation: { requires_human_approval: false },
  });
  assert.ok(violations.some((v) => /allowed_paths must be a non-empty array/.test(v)));
});

test("taskIntentViolations rejects a missing consultation flag", () => {
  const violations = taskIntentViolations({
    intent: { goal: "x", scope: { allowed_paths: ["tests/**"] } },
  });
  assert.ok(violations.some((v) => /requires_human_approval must be a boolean/.test(v)));
});

// ---------------------------------------------------------------------------
// path enforcement (pure function)
// ---------------------------------------------------------------------------

test('checkIntentPaths fails src/a.js against allowed ["tests/**"] (known-bad control)', () => {
  const violations = checkIntentPaths(["src/a.js"], {
    intent: { scope: { allowed_paths: ["tests/**"] } },
  });
  assert.ok(violations.some((v) => /src\/a\.js matches no allowed_paths/.test(v)));
});

test('checkIntentPaths passes tests/x/y.js against allowed ["tests/**"] (known-good control)', () => {
  const violations = checkIntentPaths(["tests/x/y.js"], {
    intent: { scope: { allowed_paths: ["tests/**"] } },
  });
  assert.deepEqual(violations, []);
});

test("checkIntentPaths: tests/*.js does not cover tests/x/y.js", () => {
  const violations = checkIntentPaths(["tests/x/y.js"], {
    intent: { scope: { allowed_paths: ["tests/*.js"] } },
  });
  assert.ok(violations.some((v) => /matches no allowed_paths/.test(v)));
});

test("checkIntentPaths: forbidden wins over allowed", () => {
  const violations = checkIntentPaths(["tests/fixtures/f.json"], {
    intent: {
      scope: { allowed_paths: ["tests/**"], forbidden_paths: ["tests/fixtures/**"] },
    },
  });
  assert.ok(violations.some((v) => /matches forbidden_paths/.test(v)));
});

test("checkIntentPaths exempts contract files", () => {
  const violations = checkIntentPaths([".orchestration/contracts/demo.json"], {
    intent: { scope: { allowed_paths: ["tests/**"] } },
  });
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------
// temp git repos: the --base trust model end to end
// ---------------------------------------------------------------------------

const FOREIGN_CONFIG = {
  version: 1,
  commands: { build: "npm run build" },
  folders: {
    contracts: ".orchestration/contracts",
    intents: ".orchestration/intents",
    locks: ".orchestration/locks",
    artifacts: ".orchestration/artifacts",
  },
  allowlist: ['node -e "process.exit(0)"'],
};

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

async function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-intent-"));
  try {
    git(["-c", "init.defaultBranch=main", "init", "-q"], dir);
    git(["config", "user.name", "Yukl Test"], dir);
    git(["config", "user.email", "yukl-test@example.com"], dir);
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

function writeConfig(dir, config = FOREIGN_CONFIG) {
  writeFileSync(join(dir, "yukl.config.json"), JSON.stringify(config));
}

function writeTreeFile(dir, relPath, content = "x") {
  mkdirSync(join(dir, dirname(relPath)), { recursive: true });
  writeFileSync(join(dir, relPath), content);
}

function writeIntent(dir, allowedPaths = ["src/**"], taskId = "demo") {
  mkdirSync(join(dir, ".orchestration", "intents"), { recursive: true });
  const doc = [
    "intent:",
    '  goal: "A trivial foreign-repo task."',
    "  scope:",
    "    allowed_paths:",
    ...allowedPaths.map((p) => `      - "${p}"`),
    "consultation:",
    "  requires_human_approval: false",
    "",
  ].join("\n");
  writeFileSync(join(dir, ".orchestration", "intents", `${taskId}.yml`), doc);
}

function writeContract(dir, command, filesTouched, taskId = "demo") {
  mkdirSync(join(dir, ".orchestration", "contracts"), { recursive: true });
  writeFileSync(
    join(dir, ".orchestration", "contracts", `${taskId}.json`),
    JSON.stringify({
      task_id: taskId,
      empirical_proof: [{ command, expected_exit_code: 0 }],
      files_touched: filesTouched,
    }),
  );
}

function verifyBase(dir, base = "main") {
  return spawnSync(process.execPath, [YUKL, "verify", "--base", base], {
    cwd: dir,
    encoding: "utf8",
    timeout: 120000,
  });
}

test("verify --base exits 0 when base has yukl.config.json and the task intent", async () => {
  await withTempRepo(async (dir) => {
    writeConfig(dir);
    writeIntent(dir, ["src/**"]);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    git(["checkout", "-q", "-b", "feature"], dir);

    writeTreeFile(dir, "src/a.js");
    writeContract(dir, 'node -e "process.exit(0)"', ["src/a.js"]);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "add contract"], dir);

    const result = verifyBase(dir);
    assert.equal(result.status, 0, `expected exit 0; stdout:\n${result.stdout}`);
    assert.ok(result.stdout.includes("contract demo.json paths"), "path check should run");
  });
});

test("verify --base fails when the intent exists only in the PR", async () => {
  await withTempRepo(async (dir) => {
    writeConfig(dir);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    git(["checkout", "-q", "-b", "feature"], dir);

    writeIntent(dir, ["src/**"]);
    writeTreeFile(dir, "src/a.js");
    writeContract(dir, 'node -e "process.exit(0)"', ["src/a.js"]);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "add intent and contract"], dir);

    const result = verifyBase(dir);
    assert.equal(result.status, 1, `expected exit 1; stdout:\n${result.stdout}`);
    assert.match(result.stdout, /intent for demo not found at main; merge the intent first/);
  });
});

test("verify --base passes a PR that only adds an intent file (config mode)", async () => {
  await withTempRepo(async (dir) => {
    writeConfig(dir);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    git(["checkout", "-q", "-b", "feature"], dir);

    writeIntent(dir, ["src/**"], "next-task");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "merge intent first"], dir);

    const result = verifyBase(dir);
    assert.equal(result.status, 0, `an intent-only PR must pass; stdout:\n${result.stdout}`);
  });
});

test("verify --base fails a PR adding an intent plus code with no contract", async () => {
  await withTempRepo(async (dir) => {
    writeConfig(dir);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    git(["checkout", "-q", "-b", "feature"], dir);

    writeIntent(dir, ["src/**"], "next-task");
    writeTreeFile(dir, "src/x.js");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "intent plus uncovered code"], dir);

    const result = verifyBase(dir);
    assert.equal(result.status, 1, `expected exit 1; stdout:\n${result.stdout}`);
    assert.match(result.stdout, /FAIL scope/);
    assert.match(result.stdout, /src\/x\.js/);
    assert.ok(
      !result.stdout.includes(".orchestration/intents/next-task.yml"),
      "the intent file itself is doc-exempt",
    );
  });
});

test("verify --base fails when a PR rewrites an already-merged contract (merged-intent replay)", async () => {
  await withTempRepo(async (dir) => {
    writeConfig(dir);
    writeIntent(dir, ["src/**"]);
    writeTreeFile(dir, "src/old.js");
    writeContract(dir, 'node -e "process.exit(0)"', ["src/old.js"]);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    git(["checkout", "-q", "-b", "feature"], dir);

    // Rewrite the merged contract to cover a brand-new file: the task's
    // merged intent (src/**) would otherwise authorise it.
    writeTreeFile(dir, "src/new.js");
    writeContract(dir, 'node -e "process.exit(0)"', [
      ".orchestration/contracts/demo.json",
      "src/new.js",
    ]);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "replay merged contract"], dir);

    const result = verifyBase(dir);
    assert.equal(result.status, 1, `expected exit 1; stdout:\n${result.stdout}`);
    assert.match(
      result.stdout,
      /contract demo is already merged at main; an intent authorises one PR, so use a new task_id/,
    );
  });
});

test("verify --base reads the allowlist from the base, not the PR branch", async () => {
  await withTempRepo(async (dir) => {
    writeConfig(dir);
    writeIntent(dir, ["src/**"]);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    git(["checkout", "-q", "-b", "feature"], dir);

    const marker = "node -e \"require('node:fs').writeFileSync('marker.txt', 'x')\"";
    writeTreeFile(dir, "src/a.js");
    writeContract(dir, marker, ["src/a.js"]);
    // The PR widens its own allowlist; the gate must ignore the PR's copy.
    writeConfig(dir, { ...FOREIGN_CONFIG, allowlist: [marker] });
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "widen allowlist"], dir);

    const result = verifyBase(dir);
    assert.equal(result.status, 1, `expected exit 1; stdout:\n${result.stdout}`);
    assert.match(result.stdout, /FAIL allowlist/);
    assert.equal(existsSync(join(dir, "marker.txt")), false, "the widened allowlist must not run");
  });
});

test("verify --base fails when a covered file matches no allowed_paths", async () => {
  await withTempRepo(async (dir) => {
    writeConfig(dir);
    writeIntent(dir, ["tests/**"]);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    git(["checkout", "-q", "-b", "feature"], dir);

    writeTreeFile(dir, "src/a.js");
    writeContract(dir, 'node -e "process.exit(0)"', ["src/a.js"]);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "add contract"], dir);

    const result = verifyBase(dir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /src\/a\.js matches no allowed_paths/);
  });
});

test("verify --base fails when files_touched lists a file outside the diff", async () => {
  await withTempRepo(async (dir) => {
    writeConfig(dir);
    writeIntent(dir, ["src/**"]);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    git(["checkout", "-q", "-b", "feature"], dir);

    writeTreeFile(dir, "src/a.js");
    writeContract(dir, 'node -e "process.exit(0)"', ["src/a.js", "src/other.js"]);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "add contract"], dir);

    const result = verifyBase(dir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /files_touched only lists files changed in the diff/);
    assert.match(result.stdout, /src\/other\.js/);
  });
});

test("verify --base falls back to the legacy .yukl-intent.yml when base has no yukl.config.json", async () => {
  await withTempRepo(async (dir) => {
    writeFileSync(
      join(dir, ".yukl-intent.yml"),
      [
        "rational_persuasion:",
        "  empirical_proof:",
        "    - command: 'node -e \"process.exit(0)\"'",
        "      expected_exit_code: 0",
        "",
      ].join("\n"),
    );
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    git(["checkout", "-q", "-b", "feature"], dir);

    writeTreeFile(dir, "src/a.js");
    writeContract(dir, 'node -e "process.exit(0)"', ["src/a.js"]);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "add contract"], dir);

    const result = verifyBase(dir);
    assert.equal(result.status, 0, `legacy mode should pass; stdout:\n${result.stdout}`);
    assert.ok(!result.stdout.includes("contract demo.json paths"), "legacy mode skips intents");
  });
});

// ---------------------------------------------------------------------------
// local mode (no --base): reads the working tree
// ---------------------------------------------------------------------------

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-local-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveGateConfig resolves yukl.config.json from the working tree without --base", async () => {
  await withTempDir(async (dir) => {
    writeConfig(dir);
    const resolution = resolveGateConfig({ base: null, cwd: dir });
    assert.equal(resolution.ok, true);
    assert.equal(resolution.mode, "config");
    assert.deepEqual(resolution.allowlist, FOREIGN_CONFIG.allowlist);
  });
});

test("verify without --base enforces working-tree intents", async () => {
  await withTempDir(async (dir) => {
    writeIntent(dir, ["src/**"]);
    writeContract(dir, 'node -e "process.exit(0)"', ["src/a.js"]);
    const result = await runVerify({
      contractPaths: [".orchestration/contracts/demo.json"],
      allowlist: ['node -e "process.exit(0)"'],
      gateMode: "config",
      cwd: dir,
    });
    assert.equal(result.ok, true);
    const pathCheck = result.checks.find((c) => c.name.includes("paths"));
    assert.equal(pathCheck.status, "PASS");
  });
});

test("verify without --base warns on a missing working-tree intent (pre-intent contract)", async () => {
  await withTempDir(async (dir) => {
    writeContract(dir, 'node -e "process.exit(0)"', ["src/a.js"]);
    const result = await runVerify({
      contractPaths: [".orchestration/contracts/demo.json"],
      allowlist: ['node -e "process.exit(0)"'],
      gateMode: "config",
      cwd: dir,
    });
    assert.equal(result.ok, true, "a missing intent must not fail local verification");
    const intentCheck = result.checks.find((c) => c.name.includes("intent"));
    assert.equal(intentCheck.status, "WARN");
    assert.match(
      intentCheck.detail,
      /no intent for demo \(pre-intent contract\); paths not enforced/,
    );
  });
});

test("verify without --base still fails when the working-tree intent is invalid", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, ".orchestration", "intents"), { recursive: true });
    writeFileSync(
      join(dir, ".orchestration", "intents", "demo.yml"),
      [
        "intent:",
        '  goal: "A trivial task."',
        "  scope:",
        "    allowed_paths: []",
        "consultation:",
        "  requires_human_approval: false",
        "",
      ].join("\n"),
    );
    writeContract(dir, 'node -e "process.exit(0)"', ["src/a.js"]);
    const result = await runVerify({
      contractPaths: [".orchestration/contracts/demo.json"],
      allowlist: ['node -e "process.exit(0)"'],
      gateMode: "config",
      cwd: dir,
    });
    assert.equal(result.ok, false, "a present-but-invalid intent must still fail");
    const intentCheck = result.checks.find((c) => c.name.includes("intent"));
    assert.equal(intentCheck.status, "FAIL");
    assert.match(intentCheck.detail, /allowed_paths must be a non-empty array/);
  });
});

test("verify without --base fails when a working-tree intent forbids a covered file", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, ".orchestration", "intents"), { recursive: true });
    writeFileSync(
      join(dir, ".orchestration", "intents", "demo.yml"),
      [
        "intent:",
        '  goal: "A trivial task."',
        "  scope:",
        "    allowed_paths:",
        '      - "src/**"',
        "    forbidden_paths:",
        '      - "src/secret/**"',
        "consultation:",
        "  requires_human_approval: false",
        "",
      ].join("\n"),
    );
    writeContract(dir, 'node -e "process.exit(0)"', ["src/secret/x.js"]);
    const result = await runVerify({
      contractPaths: [".orchestration/contracts/demo.json"],
      allowlist: ['node -e "process.exit(0)"'],
      gateMode: "config",
      cwd: dir,
    });
    assert.equal(result.ok, false);
    const pathCheck = result.checks.find((c) => c.name.includes("paths"));
    assert.equal(pathCheck.status, "FAIL");
    assert.match(pathCheck.detail, /src\/secret\/x\.js matches forbidden_paths/);
  });
});

test("resolveGateConfig without a config and without .yukl-intent.yml fails closed", async () => {
  await withTempDir(async (dir) => {
    const resolution = resolveGateConfig({ base: null, cwd: dir });
    assert.equal(resolution.ok, false);
    assert.match(resolution.error, /neither yukl\.config\.json nor \.yukl-intent\.yml/);
  });
});
