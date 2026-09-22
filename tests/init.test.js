import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  YUKL_BEGIN,
  YUKL_END,
  applyYuklSection,
  detectDefaultBranch,
  detectNodeCommands,
  detectPythonCommands,
  renderCiWorkflow,
  renderYuklConfig,
  renderYuklSection,
  resolveYuklPin,
  runInit,
  yuklConfigViolations,
} from "../scripts/yukl.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const YUKL = join(ROOT, "scripts", "yukl.js");

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-init-"));
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

/** A temp git repo on `main`, then a `feature` branch checked out. */
async function withFixtureRepo(fn) {
  return withTempDir(async (dir) => {
    git(["-c", "init.defaultBranch=main", "init", "-q"], dir);
    git(["config", "user.name", "Yukl Test"], dir);
    git(["config", "user.email", "yukl-test@example.com"], dir);
    return fn(dir);
  });
}

function writeTreeFile(dir, relPath, content = "x") {
  mkdirSync(join(dir, dirname(relPath)), { recursive: true });
  writeFileSync(join(dir, relPath), content);
}

function commitAll(dir, message) {
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", message], dir);
}

function runInitCli(dir, extraArgs = []) {
  return spawnSync(process.execPath, [YUKL, "init", "--cwd", dir, ...extraArgs], {
    encoding: "utf8",
    timeout: 60000,
  });
}

// ---------------------------------------------------------------------------
// detection (criterion 3)
// ---------------------------------------------------------------------------

test("detectNodeCommands maps package.json scripts and never guesses the rest", () => {
  const node = detectNodeCommands(
    JSON.stringify({ scripts: { build: "node build.js", test: "node --test" } }),
  );
  assert.equal(node.build, "npm run build");
  assert.equal(node.test, "npm run test");
  assert.equal(node.format, null);
  assert.equal(node.lint, null);
});

test("detectNodeCommands yields all nulls for a missing or unparsable package.json", () => {
  const empty = detectNodeCommands("");
  assert.deepEqual(Object.values(empty), [null, null, null, null]);
  const broken = detectNodeCommands("{not json");
  assert.deepEqual(Object.values(broken), [null, null, null, null]);
});

test("detectPythonCommands scans pyproject.toml lines for tool sections", () => {
  const python = detectPythonCommands(
    ["[tool.poetry]", "[tool.ruff]", "[tool.pytest.ini_options]", ""].join("\n"),
  );
  assert.equal(python.check, "ruff check");
  assert.equal(python.test, "pytest");
});

test("detectPythonCommands is a line scan: indented or unsupported headers are missed (documented limit)", () => {
  const python = detectPythonCommands(
    ["  [tool.ruff]", "[tool.black]", "[tool.pytest]", ""].join("\n"),
  );
  assert.equal(python.check, null, "indented headers are not detected");
  assert.equal(python.test, "pytest", "pytest section is detected");
});

test("detectPythonCommands yields nulls without a pyproject.toml", () => {
  const python = detectPythonCommands("");
  assert.equal(python.check, null);
  assert.equal(python.test, null);
});

test("renderYuklConfig writes null for undetected commands and allowlists only detected ones", () => {
  const config = renderYuklConfig(
    { build: "npm run build", test: null, format: null, lint: null },
    { check: "ruff check", test: null },
  );
  assert.equal(config.commands.build, "npm run build");
  assert.equal(config.commands.test, null);
  assert.equal(config.commands.python_check, "ruff check");
  assert.deepEqual(config.allowlist, ["npm run build", "ruff check"]);
});

test("yuklConfigViolations accepts null command entries (undetected commands, task H)", () => {
  const violations = yuklConfigViolations({
    version: 1,
    commands: { build: null, test: "npm run test" },
    folders: { contracts: ".orchestration/contracts" },
    allowlist: ["npm run test"],
  });
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------
// marked section (criterion 2, open question 1)
// ---------------------------------------------------------------------------

test("applyYuklSection appends the section and keeps every existing byte", () => {
  const original = "Existing constitution.\n\nKeep this exactly.\n";
  const applied = applyYuklSection(original, renderYuklSection({ build: null, test: null }));
  assert.ok(applied.text.startsWith(original), "existing bytes must be kept untouched");
  const added = applied.text.slice(original.length);
  assert.ok(added.startsWith(`\n${YUKL_BEGIN}`), "the section starts right after a newline");
  assert.ok(added.includes(YUKL_END));
  assert.equal(applied.replaced, false);
});

test("applyYuklSection replaces only the marked section, byte for byte outside it", () => {
  const first = applyYuklSection("Head\n\ntail\n", `${YUKL_BEGIN}\nold\n${YUKL_END}\n`);
  assert.equal(first.text, `Head\n\ntail\n\n${YUKL_BEGIN}\nold\n${YUKL_END}\n`);
  const replaced = applyYuklSection(
    `Head\n\n${YUKL_BEGIN}\nold\n${YUKL_END}\n\ntail\n`,
    `${YUKL_BEGIN}\nnew\n${YUKL_END}\n`,
  );
  assert.equal(replaced.replaced, true);
  assert.equal(replaced.text, `Head\n\n${YUKL_BEGIN}\nnew\n${YUKL_END}\n\ntail\n`);
  assert.equal(replaced.text.startsWith("Head\n\n"), true);
  assert.equal(replaced.text.endsWith("\ntail\n"), true);
});

test("applyYuklSection is idempotent", () => {
  const section = renderYuklSection({ build: "npm run build", test: null });
  const once = applyYuklSection("base\n", section);
  const twice = applyYuklSection(once.text, section);
  assert.equal(twice.text, once.text);
});

// ---------------------------------------------------------------------------
// CI workflow rendering (criterion 4, 9; open question 2)
// ---------------------------------------------------------------------------

const NO_CMDS = {
  build: null,
  test: null,
  format: null,
  lint: null,
  python_check: null,
  python_test: null,
};

test("renderCiWorkflow pins yukl to a commit and carries the bootstrap guard", () => {
  const workflow = renderCiWorkflow({
    baseRef: "main",
    yuklPin: "abc123def456",
    commands: { ...NO_CMDS, build: "npm run build" },
  });
  assert.match(
    workflow,
    /npm exec --yes --package="github:threelittlerunes\/yukl-os#abc123def456" -- yukl verify --base "origin\/\$\{\{ github\.base_ref \}\}"/,
  );
  assert.match(
    workflow,
    /bootstrap: harness not installed at base; this PR is gated by human review/,
  );
  assert.match(
    workflow,
    /git cat-file -e "origin\/\$\{\{ github\.base_ref \}\}:yukl\.config\.json"/,
  );
  assert.match(workflow, /npm run build/);
  assert.ok(!workflow.includes("setup-python"), "no python detected -> no python setup");
  const doc = yaml.load(workflow);
  assert.equal(doc.jobs["verify-contract"].steps.length, 4);
  assert.equal(doc.jobs["verify-contract"]["runs-on"], "ubuntu-latest");
});

test("renderCiWorkflow sets up Python and runs python checks only when detected", () => {
  const workflow = renderCiWorkflow({
    baseRef: "main",
    yuklPin: "abc",
    commands: { ...NO_CMDS, python_check: "ruff check", python_test: "pytest" },
  });
  assert.match(workflow, /actions\/setup-python@v5/);
  assert.match(workflow, /ruff check/);
  assert.match(workflow, /pytest/);
  assert.ok(!workflow.includes("npm ci"), "no npm commands -> no npm ci");
  assert.doesNotMatch(workflow, /\{PYTHON_SETUP\}|\{CHECKS\}/, "no placeholders may remain");
  const doc = yaml.load(workflow);
  assert.equal(doc.jobs["verify-contract"].steps.length, 5);
});

test("renderCiWorkflow leaves no placeholders and prints a notice when nothing is detected", () => {
  const workflow = renderCiWorkflow({ baseRef: "main", yuklPin: "abc", commands: NO_CMDS });
  assert.doesNotMatch(workflow, /\{BASE_REF\}|\{YUKL_PIN\}|\{PYTHON_SETUP\}|\{CHECKS\}/);
  assert.match(workflow, /no repository checks detected/);
});

test("resolveYuklPin prefers an explicit pin over checkout detection", () => {
  const flagged = resolveYuklPin({ yuklPin: "deadbeef" });
  assert.equal(flagged.ok, true);
  assert.equal(flagged.pin, "deadbeef");
});

test("resolveYuklPin detects the harness checkout HEAD when no pin is given", () => {
  const detected = resolveYuklPin({});
  assert.equal(detected.ok, true);
  assert.match(detected.pin, /^[0-9a-f]{40}$/i);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(detected.pin, head.stdout.trim());
});

// ---------------------------------------------------------------------------
// fixtures: node-only, python-only, mixed (criteria 3, 4, 7)
// ---------------------------------------------------------------------------

test("init a node-only repo: detected commands, null for the rest, checkout-sha pin", async () => {
  await withFixtureRepo(async (dir) => {
    writeTreeFile(
      dir,
      "package.json",
      JSON.stringify({ scripts: { build: "node b.js", test: "node t.js" } }),
    );
    writeTreeFile(dir, "CLAUDE.md", "constitution\n");
    commitAll(dir, "base");
    git(["checkout", "-q", "-b", "feature"], dir);

    const result = runInitCli(dir);
    assert.equal(result.status, 0, `init failed:\n${result.stdout}\n${result.stderr}`);

    const config = JSON.parse(readFileSync(join(dir, "yukl.config.json"), "utf8"));
    assert.equal(config.commands.build, "npm run build");
    assert.equal(config.commands.test, "npm run test");
    assert.equal(config.commands.format, null);
    assert.equal(config.commands.lint, null);
    assert.equal(config.commands.python_check, null);
    assert.deepEqual(config.allowlist, ["npm run build", "npm run test"]);
    assert.deepEqual(
      yuklConfigViolations(config),
      [],
      "the generated config must satisfy the schema",
    );

    const workflow = readFileSync(join(dir, ".github/workflows/yukl.yml"), "utf8");
    assert.match(workflow, /npm run build/);
    assert.ok(!workflow.includes("setup-python"));
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
    assert.ok(workflow.includes(`yukl-os#${head.stdout.trim()}`), "CI pins the checkout SHA");

    assert.equal(existsSync(join(dir, ".orchestration/contracts/.gitkeep")), true);
    assert.equal(existsSync(join(dir, ".orchestration/intents/.gitkeep")), true);
    assert.equal(
      existsSync(join(dir, "GEMINI.md")),
      false,
      "missing agent docs are skipped, not created",
    );
    assert.match(result.stderr, /GEMINI\.md does not exist/);
  });
});

test("init a python-only repo: ruff and pytest detected, python setup in CI, no npm ci", async () => {
  await withFixtureRepo(async (dir) => {
    writeTreeFile(
      dir,
      "pyproject.toml",
      [
        "[tool.ruff]",
        "line-length = 88",
        "[tool.pytest.ini_options]",
        'testpaths = ["tests"]',
        "",
      ].join("\n"),
    );
    commitAll(dir, "base");
    git(["checkout", "-q", "-b", "feature"], dir);

    const result = runInitCli(dir);
    assert.equal(result.status, 0, `init failed:\n${result.stdout}\n${result.stderr}`);

    const config = JSON.parse(readFileSync(join(dir, "yukl.config.json"), "utf8"));
    assert.equal(config.commands.python_check, "ruff check");
    assert.equal(config.commands.python_test, "pytest");
    assert.deepEqual(config.allowlist, ["ruff check", "pytest"]);
    assert.equal(config.commands.build, null);

    const workflow = readFileSync(join(dir, ".github/workflows/yukl.yml"), "utf8");
    assert.match(workflow, /actions\/setup-python@v5/);
    assert.match(workflow, /ruff check/);
    assert.match(workflow, /pytest/);
    assert.ok(!workflow.includes("npm ci"), "a repo without package.json must not run npm ci");
    assert.match(result.stderr, /CLAUDE\.md does not exist/);
  });
});

test("init a mixed repo detects node and python commands", async () => {
  await withFixtureRepo(async (dir) => {
    writeTreeFile(
      dir,
      "package.json",
      JSON.stringify({ scripts: { build: "node b.js", test: "node t.js", lint: "node l.js" } }),
    );
    writeTreeFile(
      dir,
      "pyproject.toml",
      ["[tool.ruff]", "[tool.pytest.ini_options]", ""].join("\n"),
    );
    commitAll(dir, "base");
    git(["checkout", "-q", "-b", "feature"], dir);

    const result = runInitCli(dir);
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(readFileSync(join(dir, "yukl.config.json"), "utf8"));
    assert.deepEqual(config.allowlist, [
      "npm run build",
      "npm run test",
      "npm run lint",
      "ruff check",
      "pytest",
    ]);
    assert.equal(config.commands.format, null);
    const workflow = readFileSync(join(dir, ".github/workflows/yukl.yml"), "utf8");
    assert.match(workflow, /npm ci/);
    assert.match(workflow, /setup-python@v5/);
  });
});

test("init keeps existing CLAUDE.md bytes and a second run replaces only the marked section", async () => {
  await withFixtureRepo(async (dir) => {
    const original = "Existing constitution.\n\nKeep this exactly.\n";
    writeTreeFile(dir, "CLAUDE.md", original);
    writeTreeFile(dir, "package.json", JSON.stringify({ scripts: { test: "node t.js" } }));
    commitAll(dir, "base");
    git(["checkout", "-q", "-b", "feature"], dir);

    assert.equal(runInitCli(dir).status, 0);
    const after = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    assert.ok(after.startsWith(original), "existing content must be kept byte for byte");
    assert.ok(after.includes("npm run test"));
    commitAll(dir, "first init");

    const tampered = after.replace("- `npm run test` (test)", "- `npm run test -- --check` (test)");
    writeFileSync(join(dir, "CLAUDE.md"), tampered);
    commitAll(dir, "tamper the section");
    assert.equal(runInitCli(dir).status, 0);
    assert.equal(
      readFileSync(join(dir, "CLAUDE.md"), "utf8"),
      after,
      "a second run must replace only the marked section",
    );
  });
});

// ---------------------------------------------------------------------------
// idempotency (criterion 6)
// ---------------------------------------------------------------------------

test("idempotency: running init twice leaves no diff after the second run", async () => {
  await withFixtureRepo(async (dir) => {
    writeTreeFile(dir, "package.json", JSON.stringify({ scripts: { test: "node t.js" } }));
    writeTreeFile(dir, "pyproject.toml", ["[tool.ruff]", ""].join("\n"));
    writeTreeFile(dir, "AGENTS.md", "agents constitution\n");
    commitAll(dir, "base");
    git(["checkout", "-q", "-b", "feature"], dir);

    assert.equal(runInitCli(dir).status, 0);
    commitAll(dir, "first init");
    assert.equal(runInitCli(dir).status, 0);
    const status = git(["status", "--porcelain"], dir);
    assert.equal(status.stdout, "", `second init must be a no-op, got:\n${status.stdout}`);
    assert.equal(git(["diff"], dir).stdout, "");
  });
});

// ---------------------------------------------------------------------------
// refusals (criterion 1): exit 1 and no writes
// ---------------------------------------------------------------------------

function assertNoInitWrites(dir) {
  assert.equal(
    existsSync(join(dir, "yukl.config.json")),
    false,
    "a refused init must write nothing",
  );
  assert.equal(existsSync(join(dir, ".github", "workflows", "yukl.yml")), false);
  assert.equal(existsSync(join(dir, ".orchestration", "contracts", ".gitkeep")), false);
}

test("init refuses when the target is not a git repository", async () => {
  await withTempDir(async (dir) => {
    const result = runInitCli(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a Git repository/);
    assertNoInitWrites(dir);
  });
});

test("init refuses when HEAD is the default branch", async () => {
  await withFixtureRepo(async (dir) => {
    writeTreeFile(dir, "README.md", "x");
    commitAll(dir, "base");
    const result = runInitCli(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /default branch "main"/);
    assertNoInitWrites(dir);
  });
});

test("init refuses on a detached HEAD", async () => {
  await withFixtureRepo(async (dir) => {
    writeTreeFile(dir, "README.md", "x");
    commitAll(dir, "base");
    git(["checkout", "-q", "--detach", "main"], dir);
    const result = runInitCli(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /detached HEAD/);
    assertNoInitWrites(dir);
  });
});

test("init refuses on a dirty working tree", async () => {
  await withFixtureRepo(async (dir) => {
    writeTreeFile(dir, "README.md", "x");
    commitAll(dir, "base");
    git(["checkout", "-q", "-b", "feature"], dir);
    writeTreeFile(dir, "scratch.txt", "uncommitted");
    const result = runInitCli(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /uncommitted changes/);
    assertNoInitWrites(dir);
  });
});

test("init works in a git worktree (.git is a file) on a named branch", async () => {
  await withTempDir(async (dir) => {
    const main = join(dir, "main");
    mkdirSync(main);
    git(["-c", "init.defaultBranch=main", "init", "-q"], main);
    git(["config", "user.name", "Yukl Test"], main);
    git(["config", "user.email", "yukl-test@example.com"], main);
    writeTreeFile(main, "README.md", "x");
    commitAll(main, "base");
    const wt = join(dir, "wt");
    git(["worktree", "add", "-q", "-b", "feature-wt", wt], main);
    const result = runInitCli(wt, ["--yukl-pin", "deadbeef"]);
    assert.equal(result.status, 0, `worktree init failed:\n${result.stderr}`);
    assert.equal(existsSync(join(wt, "yukl.config.json")), true);
    const workflow = readFileSync(join(wt, ".github/workflows/yukl.yml"), "utf8");
    assert.match(workflow, /yukl-os#deadbeef/);
  });
});

// ---------------------------------------------------------------------------
// colocated Jujutsu (requirement A)
// ---------------------------------------------------------------------------

function jjAvailable() {
  return spawnSync("jj", ["--version"], { encoding: "utf8" }).status === 0;
}

function jj(cwd, args) {
  const result = spawnSync(
    "jj",
    [
      "--config",
      'user.name="Yukl Test"',
      "--config",
      'user.email="yukl-test@example.com"',
      "--repository",
      cwd,
      ...args,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `jj ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

test(
  "init in a colocated Jujutsu repo refuses while @ is the default branch tip and allows a change on top",
  { skip: jjAvailable() ? false : "jj binary not available (e.g. on CI)" },
  async () => {
    await withTempDir(async (dir) => {
      const cfg = [
        "--config",
        'user.name="Yukl Test"',
        "--config",
        'user.email="yukl-test@example.com"',
      ];
      let result = spawnSync("jj", [...cfg, "git", "init", "--colocate", dir], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      writeFileSync(join(dir, "README.md"), "base\n");
      jj(dir, ["describe", "-m", "base"]);
      jj(dir, ["bookmark", "create", "main", "-r", "@"]);

      const refused = runInitCli(dir);
      assert.equal(refused.status, 1, `expected refusal while @ is the main tip`);
      assert.match(refused.stderr, /jj new/);
      assert.equal(
        existsSync(join(dir, "yukl.config.json")),
        false,
        "a refused init must write nothing",
      );

      jj(dir, ["new"]);
      writeTreeFile(dir, "src/x.js", "x\n");
      const allowed = runInitCli(dir);
      assert.equal(
        allowed.status,
        0,
        `init after jj new must succeed (git HEAD is always detached in colocated jj):\n${allowed.stderr}`,
      );
      assert.equal(existsSync(join(dir, "yukl.config.json")), true);
    });
  },
);

// ---------------------------------------------------------------------------
// --force (criterion 3)
// ---------------------------------------------------------------------------

test("init leaves an existing yukl.config.json alone unless --force is passed", async () => {
  await withFixtureRepo(async (dir) => {
    writeTreeFile(dir, "package.json", JSON.stringify({ scripts: { test: "node t.js" } }));
    writeTreeFile(
      dir,
      "yukl.config.json",
      JSON.stringify(
        {
          version: 1,
          commands: { build: "npm run build", test: "npm run test", format: "npm run format" },
          folders: { contracts: ".orchestration/contracts" },
          allowlist: ["npm run build"],
        },
        null,
        2,
      ),
    );
    commitAll(dir, "base");
    git(["checkout", "-q", "-b", "feature"], dir);

    const first = runInitCli(dir);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /yukl\.config\.json already exists; pass --force/);
    const untouched = readFileSync(join(dir, "yukl.config.json"), "utf8");
    assert.match(untouched, /"allowlist": \[/);
    assert.ok(!untouched.includes('"python_check"'), "existing config must be left alone");
    commitAll(dir, "first init");

    const forced = runInitCli(dir, ["--force"]);
    assert.equal(forced.status, 0, forced.stderr);
    const rewritten = JSON.parse(readFileSync(join(dir, "yukl.config.json"), "utf8"));
    assert.equal(rewritten.commands.python_check, null);
  });
});

// ---------------------------------------------------------------------------
// bootstrap guard in CI (criterion 9): both base states
// ---------------------------------------------------------------------------

test("bootstrap: the CI guard skips verify without the config at the base and runs it once merged", async () => {
  await withFixtureRepo(async (dir) => {
    writeTreeFile(dir, "README.md", "x");
    commitAll(dir, "base");
    git(["checkout", "-q", "-b", "feature"], dir);

    assert.equal(runInitCli(dir).status, 0);
    const workflow = readFileSync(join(dir, ".github/workflows/yukl.yml"), "utf8");
    assert.match(
      workflow,
      /bootstrap: harness not installed at base; this PR is gated by human review/,
    );

    let guard = spawnSync("git", ["cat-file", "-e", "main:yukl.config.json"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.notEqual(
      guard.status,
      0,
      "before the config is at the base, the guard must skip verify",
    );

    commitAll(dir, "init PR");
    git(["checkout", "-q", "main"], dir);
    git(["merge", "-q", "--no-ff", "feature", "-m", "merge init"], dir);
    guard = spawnSync("git", ["cat-file", "-e", "main:yukl.config.json"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(guard.status, 0, "once the config is at the base, the guard must let verify run");
  });
});

// ---------------------------------------------------------------------------
// bin shim entry point (criterion 8): npm pack + install + run .bin shim
// ---------------------------------------------------------------------------

test("bin shim: yukl runs main() through an installed npm .bin shim (npm pack + install)", () => {
  const dir = mkdtempSync(join(tmpdir(), "yukl-shim-"));
  try {
    const npmSpawn = (args, cwd) =>
      spawnSync("npm", args, {
        cwd,
        encoding: "utf8",
        shell: process.platform === "win32",
        timeout: 180000,
      });
    const pack = npmSpawn(["pack", "--pack-destination", dir], ROOT);
    assert.equal(pack.status, 0, `npm pack failed:\n${pack.stdout}\n${pack.stderr}`);
    const tarball = join(dir, pack.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));

    const app = join(dir, "app");
    mkdirSync(app);
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify({ name: "shim-app", version: "1.0.0", private: true }),
    );
    const install = npmSpawn(["install", tarball], app);
    assert.equal(install.status, 0, `npm install failed:\n${install.stdout}\n${install.stderr}`);

    writeFileSync(
      join(app, ".yukl-intent.yml"),
      [
        "rational_persuasion:",
        "  empirical_proof:",
        "    - command: 'node -e \"process.exit(0)\"'",
        "      expected_exit_code: 0",
        "",
      ].join("\n"),
    );
    mkdirSync(join(app, ".orchestration", "contracts"), { recursive: true });
    writeFileSync(
      join(app, ".orchestration", "contracts", "shim.json"),
      JSON.stringify({
        task_id: "shim",
        empirical_proof: [{ command: 'node -e "process.exit(0)"', expected_exit_code: 0 }],
        files_touched: ["src/shim.js"],
      }),
    );

    const shim = join(
      app,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "yukl.cmd" : "yukl",
    );
    assert.equal(existsSync(shim), true, `expected an installed shim at ${shim}`);
    const result = spawnSync(shim, ["verify", ".orchestration/contracts/shim.json", "--cwd", app], {
      cwd: app,
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 60000,
    });
    assert.equal(
      result.status,
      0,
      `shim run must reach main() and pass verify:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /contract shim\.json/);
    assert.match(result.stdout, /PASS/);
  } finally {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (err.code !== "EPERM" && err.code !== "EBUSY") throw err;
      }
    }
  }
});

// ---------------------------------------------------------------------------
// runInit API + default branch detection
// ---------------------------------------------------------------------------

test("runInit returns a refusal for a non-repo instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "yukl-init-api-"));
  try {
    const result = runInit({ cwd: dir });
    assert.equal(result.ok, false);
    assert.match(result.error, /not a Git repository/);
    assert.deepEqual(result.writes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectDefaultBranch falls back to main without origin/HEAD", async () => {
  await withFixtureRepo(async (dir) => {
    writeTreeFile(dir, "README.md", "x");
    commitAll(dir, "base");
    assert.equal(detectDefaultBranch(dir), "main");
  });
});
