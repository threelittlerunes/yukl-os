import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createVcs as createGithubVcs } from "../scripts/adapters/vcs-github.js";
import { run, mapToPolicyId } from "../scripts/commands/run.js";
import { appendEvent, headHash, readEvents } from "../scripts/lifecycle/events.js";
import { requiresHuman } from "../scripts/lifecycle/policy.js";
import {
  lifecycleViolations,
  name as lifecycleName,
  validate as validateLifecycle,
} from "../scripts/validators/lifecycle.js";
import { JJ_WC_BOOKMARK } from "../scripts/yukl.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const YUKL = join(ROOT, "scripts", "yukl.js");
const FAKE_GH = join(ROOT, "tests", "fixtures", "fake-gh", "fake-gh.js");
const TASK = "task-run";
const SEED_COMMIT = "a".repeat(40);
const GIT_IDENTITY = ["-c", "user.email=yukl-test@example.invalid", "-c", "user.name=Yukl Test"];

// A temporary runtime adapter that settles with a zero exit code as soon as it
// is polled, so a test can drive a full step without a real agent. Its module
// scope records every start, which survives across two run() calls.
const FAKE_ADAPTER = [
  "const starts = [];",
  "const createdWith = [];",
  "let count = 0;",
  "export function createFakeRuntime(options = {}) {",
  "  createdWith.push(options);",
  "  return {",
  "    start(input = {}) {",
  "      count += 1;",
  "      const id = `fake-${count}`;",
  "      starts.push({ id, ...input });",
  "      return id;",
  "    },",
  "    status(id) {",
  '      return starts.some((entry) => entry.id === id) ? "exited" : "unverifiable";',
  "    },",
  "    result(id) {",
  "      return starts.some((entry) => entry.id === id) ? { exitCode: 0 } : null;",
  "    },",
  "    stop() {},",
  "  };",
  "}",
  "export { starts, createdWith };",
].join("\n");

// A placeholder VCS adapter, present only so the lifecycle block validates; the
// tests that need a merge inject the real vcs-github adapter instead.
const VCS_ADAPTER = [
  "export function createVcs() {",
  "  return {",
  '    name: "vcs-github",',
  "    checks: async () => ({ ok: false, results: [] }),",
  '    merge: async () => ({ ok: false, error: "placeholder adapter" }),',
  "  };",
  "}",
].join("\n");

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-run-"));
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

/** Run the CLI from the repository root, capturing its status and streams. */
function runCli(args) {
  return spawnSync(process.execPath, [YUKL, "run", ...args], { cwd: ROOT, encoding: "utf8" });
}

/** Capture console output around an async call, for in-process run() checks. */
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

function git(args, cwd) {
  const result = spawnSync("git", [...GIT_IDENTITY, ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/** Read the repository's committed policy (all run budgets are null). */
function committedPolicy() {
  return JSON.parse(readFileSync(join(ROOT, "yukl.policy.json"), "utf8"));
}

function baseConfig(lifecycle) {
  return {
    version: 1,
    commands: { build: "npm run build", test: "npm run test", format: "npm run format" },
    folders: {
      contracts: ".orchestration/contracts",
      intents: ".orchestration/intents",
      locks: ".orchestration/locks",
      artifacts: ".orchestration/artifacts",
    },
    allowlist: ["npm run build", "npm run test"],
    lifecycle,
  };
}

function gitRepo(lifecycle, policy, extra = {}) {
  return {
    lifecycle: lifecycle ?? {
      runtimes: { implement: { adapter: "fake", agent: "opencode" } },
      vcs: "vcs-github",
      stateDir: ".orchestration/state",
    },
    policy: policy ?? committedPolicy(),
    ...extra,
  };
}

/**
 * Build a temporary repository: a git checkout with one commit, a lifecycle
 * block, a policy, the temporary adapters and a seeded log. Returns the state
 * directory and the URL of the temporary fake adapter.
 */
function writeRepo(dir, spec = {}) {
  const layout = gitRepo(spec.lifecycle, spec.policy, spec);
  mkdirSync(join(dir, "scripts", "adapters"), { recursive: true });
  writeFileSync(join(dir, "scripts", "adapters", "fake.js"), FAKE_ADAPTER);
  writeFileSync(join(dir, "scripts", "adapters", "vcs-github.js"), VCS_ADAPTER);
  writeFileSync(
    join(dir, "yukl.config.json"),
    `${JSON.stringify(baseConfig(layout.lifecycle), null, 2)}\n`,
  );
  writeFileSync(join(dir, "yukl.policy.json"), `${JSON.stringify(layout.policy, null, 2)}\n`);
  writeFileSync(join(dir, "README.md"), "temp\n");
  git(["init", "-q"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "seed"], dir);

  const stateDir = join(dir, ".orchestration", "state");
  if (Array.isArray(spec.seed)) {
    for (const [stage, to] of spec.seed) seedStageDone(stateDir, stage, to);
  }
  return {
    stateDir,
    fakeAdapterUrl: pathToFileURL(join(dir, "scripts", "adapters", "fake.js")).href,
    adaptersDir: join(dir, "scripts", "adapters"),
  };
}

const SEED_ACTORS = { implement: "drafter", audit: "auditor", review: "reviewer" };

function seedStageDone(stateDir, stage, to) {
  appendEvent(stateDir, TASK, {
    type: "stage_done",
    actor: SEED_ACTORS[stage] ?? "seed",
    anchor: { path: `${stage}.md`, commit: SEED_COMMIT },
    data: { stage, to },
  });
}

const SEED_TO_IMPLEMENT = [
  ["intent", "scope"],
  ["scope", "plan"],
  ["plan", "implement"],
];

const SEED_TO_INTEGRATE = [
  ["intent", "scope"],
  ["scope", "plan"],
  ["plan", "implement"],
  ["implement", "prove"],
  ["prove", "audit"],
  ["audit", "review"],
  ["review", "integrate"],
];

function stageDoneTo(stateDir, to) {
  return readEvents(stateDir, TASK).events.filter(
    (event) => event.type === "stage_done" && event.data.to === to,
  );
}

// ---------------------------------------------------------------------------
// usage errors exit 2
// ---------------------------------------------------------------------------

test("run refuses bad usage with exit 2", () => {
  const cases = [
    [[], /missing <task_id>/],
    [["--once"], /missing <task_id>/],
    [[TASK, "extra"], /unexpected argument/],
    [[TASK, "--bogus"], /unknown option/],
    [[TASK, "--cwd"], /--cwd requires a value/],
    [["Bad/Id", "--once"], /lower-case path segment/],
  ];
  for (const [args, pattern] of cases) {
    const result = runCli(args);
    assert.equal(result.status, 2, `expected exit 2 for ${args.join(" ")}`);
    assert.match(result.stderr, pattern);
  }
});

// ---------------------------------------------------------------------------
// control: the fake adapter advances one stage and carries the configured agent
// ---------------------------------------------------------------------------

test("run --once drives one stage with the configured adapter and agent", async () => {
  await withTempDir(async (dir) => {
    const repo = writeRepo(dir, { seed: SEED_TO_IMPLEMENT });

    const first = await capture(() => run([TASK, "--once", "--cwd", dir]));
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /yukl run: started at implement/);

    const second = await capture(() => run([TASK, "--once", "--cwd", dir]));
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /yukl run: advanced implement -> prove/);

    const done = stageDoneTo(repo.stateDir, "prove");
    assert.equal(done.length, 1, "exactly one stage_done moves implement to prove");
    assert.equal(done[0].data.stage, "implement");

    const mod = await import(repo.fakeAdapterUrl);
    assert.equal(
      mod.createdWith[0].agent,
      "opencode",
      "the factory is built with the config agent",
    );
    assert.equal(mod.starts.length, 1, "the fake runtime is started exactly once");
    assert.equal(mod.starts[0].stage, "implement");
    assert.match(mod.starts[0].spec, /opencode/, "the configured agent reaches the start spec");
  });
});

// ---------------------------------------------------------------------------
// no Jujutsu workspace: the working-copy sync hook stays off
// ---------------------------------------------------------------------------

test("run in a repo with no Jujutsu workspace leaves jjBase null and publishes nothing", async () => {
  await withTempDir(async (dir) => {
    writeRepo(dir, { seed: SEED_TO_IMPLEMENT });

    const jjBases = [];
    const starts = [];
    const { code, out } = await capture(() =>
      run([TASK, "--once", "--cwd", dir], {
        createRuntime: (entry, context) => {
          jjBases.push(context.jjBase);
          return {
            start: (dispatch) => {
              starts.push(dispatch);
              return "run-1";
            },
            status: () => "exited",
            result: () => ({ exitCode: 0 }),
            stop: () => {},
          };
        },
      }),
    );
    assert.equal(code, 0, out);
    assert.deepEqual(
      jjBases,
      [null],
      "a plain Git repository has no jj base, so no sync wrapper is applied",
    );
    assert.match(out, /yukl run: started at implement/, "existing run behaviour is unchanged");
    assert.equal(starts.length, 1, "the runtime is started exactly once");

    // Nothing was published, so the working-copy branch never appears here.
    const ref = spawnSync(
      "git",
      [...GIT_IDENTITY, "rev-parse", "--verify", "--quiet", "refs/heads/yukl-wc"],
      { cwd: dir, encoding: "utf8" },
    );
    assert.notEqual(ref.status, 0, "no working-copy ref is created without a Jujutsu workspace");
  });
});

// ---------------------------------------------------------------------------
// an unreadable Jujutsu workspace: the sync hook stays on, so a stale tip is
// never branched
// ---------------------------------------------------------------------------

test("run under an unreadable Jujutsu workspace fails closed instead of branching from the tip", async () => {
  await withTempDir(async (dir) => {
    // `.jj` in a parent directory, and not a real workspace: whether jj is
    // missing or reports that it cannot read it, this is not plain Git, so the
    // run has to go through the working-copy sync (jjBase set) instead of
    // handing the agent a branch tip that predates the working copy.
    mkdirSync(join(dir, ".jj"), { recursive: true });
    writeFileSync(join(dir, ".jj", "repo"), "not a workspace\n");

    // The real dispatch path: the sync hook refuses before any agent starts.
    const refused = join(dir, "refused");
    mkdirSync(refused);
    const repo = writeRepo(refused, { seed: SEED_TO_IMPLEMENT });

    const blocked = await capture(() => run([TASK, "--once", "--cwd", refused]));
    assert.equal(blocked.code, 1, blocked.out);
    assert.match(blocked.err, /refusing to dispatch an agent/);
    assert.match(blocked.err, /\.jj is present in /);
    const mod = await import(repo.fakeAdapterUrl);
    assert.equal(mod.starts.length, 0, "no agent is started from an unprovable base");
    const ref = spawnSync(
      "git",
      [...GIT_IDENTITY, "rev-parse", "--verify", "--quiet", `refs/heads/${JJ_WC_BOOKMARK}`],
      { cwd: refused, encoding: "utf8" },
    );
    assert.notEqual(ref.status, 0, "an unreadable workspace publishes nothing");

    // And the base the run is built against is the working-copy ref, not the
    // null that made the dispatcher branch from a stale tip.
    const observed = join(dir, "observed");
    mkdirSync(observed);
    writeRepo(observed, { seed: SEED_TO_IMPLEMENT });
    const jjBases = [];
    const unguarded = await capture(() =>
      run([TASK, "--once", "--cwd", observed], {
        createRuntime: (entry, context) => {
          jjBases.push(context.jjBase);
          return {
            start: () => "run-1",
            status: () => "exited",
            result: () => ({ exitCode: 0 }),
            stop: () => {},
          };
        },
      }),
    );
    assert.deepEqual(
      jjBases,
      [JJ_WC_BOOKMARK],
      "the run is built against the working-copy ref, not the branch tip",
    );
    assert.equal(unguarded.code, 0, unguarded.err);
  });
});

// ---------------------------------------------------------------------------
// must reject: an unattended run with unset budgets starts no adapter
// ---------------------------------------------------------------------------

test("--unattended with the committed all-null policy exits 1 before any adapter start", async () => {
  await withTempDir(async (dir) => {
    writeRepo(dir, { policy: committedPolicy() });
    let created = 0;
    const { code, err } = await capture(() =>
      run([TASK, "--unattended", "--cwd", dir], {
        createRuntime: () => {
          created += 1;
          return null;
        },
      }),
    );
    assert.equal(code, 1);
    assert.equal(created, 0, "no runtime is built before the refusal");
    assert.match(err, /maxWallMinutesPerRun/);
    assert.match(err, /maxTokensPerRun/);
    assert.match(err, /maxAgentStartsPerRun/);
  });
});

test("the CLI refuses --unattended with exit 1 against the committed policy", async () => {
  await withTempDir(async (dir) => {
    writeRepo(dir, { policy: committedPolicy() });
    const result = runCli([TASK, "--unattended", "--cwd", dir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--unattended is refused/);
  });
});

// ---------------------------------------------------------------------------
// must reject: an auto_at_level the run has not earned blocks for a human
// ---------------------------------------------------------------------------

test("a transition gated at level 1 blocks with R-NEEDS-HUMAN at level 0", async () => {
  await withTempDir(async (dir) => {
    const policy = committedPolicy();
    policy.autonomy["advance-stage-on-gate-pass"] = { auto_at_level: 1 };
    const repo = writeRepo(dir, { policy, seed: SEED_TO_IMPLEMENT });

    const result = runCli([TASK, "--cwd", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /R-NEEDS-HUMAN/);
    assert.equal(
      stageDoneTo(repo.stateDir, "prove").length,
      0,
      "a refused advance must append nothing that moves the stage",
    );
  });
});

// ---------------------------------------------------------------------------
// the policy mapping fails closed
// ---------------------------------------------------------------------------

test("mapToPolicyId maps the two known edges and leaves anything else unknown", () => {
  assert.equal(mapToPolicyId("advance:integrate->done"), "merge-implementation-pr");
  assert.equal(mapToPolicyId("advance:scope->plan"), "advance-stage-on-gate-pass");
  assert.equal(mapToPolicyId("advance:review->integrate"), "advance-stage-on-gate-pass");
  assert.equal(mapToPolicyId("merge-intent-pr"), "merge-intent-pr");
  assert.equal(mapToPolicyId("mystery"), "mystery");
});

test("an unmapped edge reaches the policy untouched and fails closed", () => {
  const policy = committedPolicy();
  assert.equal(requiresHuman(policy, mapToPolicyId("not-a-transition"), 5), true);

  const gated = {
    ...policy,
    autonomy: { ...policy.autonomy, "advance-stage-on-gate-pass": { auto_at_level: 1 } },
  };
  assert.equal(requiresHuman(gated, mapToPolicyId("advance:scope->plan"), 0), true);
  assert.equal(requiresHuman(gated, mapToPolicyId("advance:scope->plan"), 1), false);
});

// ---------------------------------------------------------------------------
// control: one engine merge through vcs-github writes the run-head trailer
// ---------------------------------------------------------------------------

test("an integrate merge writes the Yukl-Run-Head trailer with the log head", async () => {
  await withTempDir(async (dir) => {
    const repo = writeRepo(dir, { seed: SEED_TO_INTEGRATE });

    const scenarioPath = join(dir, "scenario.json");
    const logPath = join(dir, "gh.log");
    writeFileSync(
      scenarioPath,
      JSON.stringify({
        "pr checks": { exitCode: 0, stdout: JSON.stringify([{ name: "build", state: "SUCCESS" }]) },
        "pr view": { exitCode: 0, stdout: JSON.stringify({ baseRefName: "main" }) },
        "pr merge": { exitCode: 0, stdout: "" },
      }),
    );
    const savedScenario = process.env.FAKE_GH_SCENARIO;
    const savedLog = process.env.FAKE_GH_LOG;
    process.env.FAKE_GH_SCENARIO = scenarioPath;
    process.env.FAKE_GH_LOG = logPath;
    try {
      const { code, err } = await capture(() =>
        run([TASK, "--cwd", dir], {
          createVcs: () => createGithubVcs({ gh: [process.execPath, FAKE_GH], cwd: dir }),
        }),
      );
      assert.equal(code, 0, err);
    } finally {
      if (savedScenario === undefined) delete process.env.FAKE_GH_SCENARIO;
      else process.env.FAKE_GH_SCENARIO = savedScenario;
      if (savedLog === undefined) delete process.env.FAKE_GH_LOG;
      else process.env.FAKE_GH_LOG = savedLog;
    }

    const argv = readFileSync(logPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((entry) => entry[0] === "pr" && entry[1] === "merge");
    assert.ok(argv, "the merge must reach the GitHub CLI");
    const body = argv[argv.indexOf("--body") + 1];
    assert.match(body, new RegExp(`^Yukl-Run-Head: ${TASK} [0-9a-f]{64}$`));

    const log = readEvents(repo.stateDir, TASK);
    const marker = log.events.findIndex(
      (event) => event.type === "stage_started" && event.data.stage === "integrate",
    );
    assert.ok(marker >= 0, "the engine records the merge marker before merging");
    const expected = headHash({
      events: log.events.slice(0, marker + 1),
      lines: log.lines.slice(0, marker + 1),
    });
    assert.equal(body, `Yukl-Run-Head: ${TASK} ${expected}`);
    assert.equal(stageDoneTo(repo.stateDir, "done").length, 1);
  });
});

// ---------------------------------------------------------------------------
// the lifecycle validator
// ---------------------------------------------------------------------------

test("the lifecycle validator plugin is named lifecycle", () => {
  assert.equal(lifecycleName, "lifecycle");
});

test("the committed lifecycle block validates against the repository root", () => {
  const committed = JSON.parse(readFileSync(join(ROOT, "yukl.config.json"), "utf8")).lifecycle;
  assert.deepEqual(lifecycleViolations(committed, ROOT), []);
});

test("lifecycleViolations rejects an adapter with no file and a stateDir outside the root", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, "scripts", "adapters"), { recursive: true });
    writeFileSync(join(dir, "scripts", "adapters", "orca.js"), "");
    writeFileSync(join(dir, "scripts", "adapters", "vcs-github.js"), "");

    const good = {
      runtimes: { implement: { adapter: "orca", agent: "opencode" } },
      vcs: "vcs-github",
      stateDir: ".orchestration/state",
    };
    assert.deepEqual(lifecycleViolations(good, dir), []);

    const missingAdapter = {
      ...good,
      runtimes: { implement: { adapter: "nope", agent: "opencode" } },
    };
    const adapterErrors = lifecycleViolations(missingAdapter, dir);
    assert.ok(adapterErrors.some((e) => /scripts\/adapters\/nope\.js/.test(e)));

    const escaped = { ...good, stateDir: "../outside" };
    const stateErrors = lifecycleViolations(escaped, dir);
    assert.ok(stateErrors.some((e) => /inside the repository root/.test(e)));

    assert.ok(lifecycleViolations({ ...good, vcs: "missing" }, dir).some((e) => /missing/.test(e)));
    assert.ok(
      lifecycleViolations(
        { ...good, runtimes: { implement: { adapter: "orca", agent: "" } } },
        dir,
      ).some((e) => /agent must be a non-empty string/.test(e)),
    );
  });
});

test("validate reads yukl.config.json and checks a present block, tolerating absence", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, "scripts", "adapters"), { recursive: true });
    writeFileSync(join(dir, "scripts", "adapters", "orca.js"), "");
    writeFileSync(join(dir, "scripts", "adapters", "vcs-github.js"), "");

    const good = {
      runtimes: { implement: { adapter: "orca", agent: "opencode" } },
      vcs: "vcs-github",
      stateDir: ".orchestration/state",
    };
    writeFileSync(join(dir, "yukl.config.json"), JSON.stringify({ lifecycle: good }));
    assert.deepEqual(validateLifecycle(dir).errors, []);

    writeFileSync(
      join(dir, "yukl.config.json"),
      JSON.stringify({
        lifecycle: { ...good, runtimes: { implement: { adapter: "nope", agent: "opencode" } } },
      }),
    );
    const bad = validateLifecycle(dir).errors;
    assert.equal(bad.length, 1);
    assert.match(bad[0], /^yukl.config.json: /);

    writeFileSync(join(dir, "yukl.config.json"), JSON.stringify({ version: 1 }));
    assert.deepEqual(validateLifecycle(dir).errors, []);
  });
});
