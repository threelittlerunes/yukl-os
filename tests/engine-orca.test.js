import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOrcaRuntime } from "../scripts/adapters/orca.js";
import { run } from "../scripts/commands/run.js";
import { appendEvent, readEvents } from "../scripts/lifecycle/events.js";

// `yukl run` over the real Orca adapter and the fake Orca CLI.
//
// This is the seam the shipped `{ dispatchId }` handle broke: the engine
// recorded the handle object in `stage_started` and handed it back on the next
// poll, `handleId` refused it ("runtime.start must return a non-empty string
// handle id") after Orca had already started one worker, and the run could
// never advance. The test drives the real composition root through a temporary
// repository and asserts the whole chain: one worker-start, the dispatch id
// recorded as the handle, and the next step advancing `implement -> prove`
// once worker-show reports the worker exited and its outcome succeeded.
//
// The second test covers the other side of the same mapping: an exited worker
// whose outcome is neither `succeeded` nor `failed` yields no exit code, and
// the engine refuses that poll - `stage_failed` with `runtimeRefused` - rather
// than advancing or silently succeeding the stage.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_ORCA = join(ROOT, "tests", "fixtures", "fake-orca", "fake-orca.js");
const TASK = "task-orca";
const SEED_COMMIT = "a".repeat(40);
const GIT_IDENTITY = ["-c", "user.email=yukl-test@example.invalid", "-c", "user.name=Yukl Test"];

// A re-export of the real adapter, present so the temporary lifecycle block
// validates: `lifecycleViolations` requires a file per adapter name, while the
// test injects `createRuntime` and never imports this shim.
const ORCA_ADAPTER_SHIM = `export { createOrcaRuntime } from ${JSON.stringify(
  pathToFileURL(join(ROOT, "scripts", "adapters", "orca.js")).href,
)};\n`;

// A placeholder VCS adapter, present only so the lifecycle block validates; the
// test injects `createVcs`, so no merge ever runs.
const VCS_ADAPTER = [
  "export function createVcs() {",
  "  return {",
  '    name: "vcs-github",',
  "    checks: async () => ({ ok: false, results: [] }),",
  '    merge: async () => ({ ok: false, error: "placeholder adapter" }),',
  "  };",
  "}",
].join("\n");

const BASE_CONFIG = {
  version: 1,
  commands: { build: "npm run build", test: "npm run test", format: "npm run format" },
  folders: {
    contracts: ".orchestration/contracts",
    intents: ".orchestration/intents",
    locks: ".orchestration/locks",
    artifacts: ".orchestration/artifacts",
  },
  allowlist: ["npm run build", "npm run test"],
  lifecycle: {
    runtimes: { implement: { adapter: "orca", agent: "omp" } },
    vcs: "vcs-github",
    stateDir: ".orchestration/state",
  },
};

const SEED_ACTORS = { intent: "human", scope: "drafter", plan: "drafter" };
const SEED_TO_IMPLEMENT = [
  ["intent", "scope"],
  ["scope", "plan"],
  ["plan", "implement"],
];

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-engine-orca-"));
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

function readCalls(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * The injected dependencies shared by both integration tests: the real Orca
 * adapter driving the fake CLI, a VCS stub whose merge never runs, and anchors
 * that resolve every stage to the seed commit.
 */
function runOverrides() {
  return {
    createRuntime: (entry) =>
      createOrcaRuntime({ orca: [process.execPath, FAKE_ORCA], agent: entry.agent }),
    createVcs: () => ({
      name: "vcs-github",
      checks: async () => ({ ok: false, results: [] }),
      merge: async () => ({ ok: false, error: "stub vcs" }),
    }),
    anchors: {
      anchorStage: async (stage) => ({
        ok: true,
        anchor: { path: `${stage}.md`, commit: SEED_COMMIT },
      }),
    },
  };
}

/**
 * Point the fake Orca at `scenario` and append its calls to `logPath` for the
 * duration of `fn`, restoring the previous environment afterwards.
 */
async function withFakeOrca({ scenario, logPath }, fn) {
  const scenarioPath = join(dirname(logPath), "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const savedLog = process.env.FAKE_ORCA_LOG;
  const savedScenario = process.env.FAKE_ORCA_SCENARIO;
  process.env.FAKE_ORCA_LOG = logPath;
  process.env.FAKE_ORCA_SCENARIO = scenarioPath;
  try {
    return await fn();
  } finally {
    if (savedLog === undefined) delete process.env.FAKE_ORCA_LOG;
    else process.env.FAKE_ORCA_LOG = savedLog;
    if (savedScenario === undefined) delete process.env.FAKE_ORCA_SCENARIO;
    else process.env.FAKE_ORCA_SCENARIO = savedScenario;
  }
}

/**
 * Build the temporary repository the run reads: a git checkout with one
 * commit, the `implement -> orca/omp` lifecycle block, the repository's own
 * policy, the adapter shims and a log seeded at `implement`. Returns the state
 * directory and the fake Orca's call log path.
 */
function writeRepo(dir) {
  mkdirSync(join(dir, "scripts", "adapters"), { recursive: true });
  writeFileSync(join(dir, "scripts", "adapters", "orca.js"), ORCA_ADAPTER_SHIM);
  writeFileSync(join(dir, "scripts", "adapters", "vcs-github.js"), VCS_ADAPTER);
  writeFileSync(join(dir, "yukl.config.json"), `${JSON.stringify(BASE_CONFIG, null, 2)}\n`);
  writeFileSync(
    join(dir, "yukl.policy.json"),
    readFileSync(join(ROOT, "yukl.policy.json"), "utf8"),
  );
  git(["init", "-q"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "seed"], dir);

  const stateDir = join(dir, ".orchestration", "state");
  for (const [stage, to] of SEED_TO_IMPLEMENT) {
    appendEvent(stateDir, TASK, {
      type: "stage_done",
      actor: SEED_ACTORS[stage] ?? "seed",
      anchor: { path: `${stage}.md`, commit: SEED_COMMIT },
      data: { stage, to },
    });
  }
  return { stateDir, logPath: join(dir, "calls.log") };
}

test("yukl run --once drives a real-adapter start to an advanced stage", async () => {
  await withTempDir(async (dir) => {
    const { stateDir, logPath } = writeRepo(dir);
    // The worker record names the checkout the worker ran in. The real adapter
    // now reports that worktree through `workspace`, and the composition root
    // resolves its HEAD, so a record that names no path would block the stage
    // (see the unresolvable-workspace test below). The temp repo itself stands
    // in for the worker's worktree here.
    const scenario = {
      "worker-start": { json: { ok: true, result: { dispatchId: "ctx_fake_1" } } },
      "worker-show": {
        json: {
          ok: true,
          result: {
            terminal: { worktreePath: dir },
            projection: { liveness: { verdict: "exited" }, outcome: "succeeded" },
          },
        },
      },
    };

    await withFakeOrca({ scenario, logPath }, async () => {
      const overrides = runOverrides();

      const first = await capture(() => run([TASK, "--once", "--cwd", dir], overrides));
      assert.equal(first.code, 0, first.err);
      assert.match(first.out, /yukl run: started at implement/);

      // The handle the engine recorded is the dispatch id string. The shipped
      // `{ dispatchId }` handle failed right here, after the worker had already
      // been started, so this is the regression guard for the handle contract.
      const started = readEvents(stateDir, TASK).events.filter(
        (event) => event.type === "stage_started" && event.data.stage === "implement",
      );
      assert.equal(started.length, 1, "one stage_started is recorded for implement");
      assert.equal(
        started[0].data.handle,
        "ctx_fake_1",
        "the recorded handle is the dispatch id itself",
      );
      assert.equal(typeof started[0].data.handle, "string");

      const second = await capture(() => run([TASK, "--once", "--cwd", dir], overrides));
      assert.equal(second.code, 0, second.err);
      assert.match(second.out, /yukl run: advanced/);
      assert.match(second.out, /implement -> prove/);

      const done = readEvents(stateDir, TASK).events.filter(
        (event) => event.type === "stage_done" && event.data.to === "prove",
      );
      assert.equal(done.length, 1, "exactly one stage_done moves implement to prove");
      assert.equal(done[0].data.stage, "implement");

      const calls = readCalls(logPath);
      const starts = calls.filter((argv) => argv[1] === "worker-start");
      assert.equal(starts.length, 1, "exactly one worker-start is logged across both runs");
      assert.equal(
        starts[0].includes("--base-branch"),
        false,
        "no base is known here, so the flag pair is omitted entirely",
      );
      assert.equal(starts[0][starts[0].indexOf("--agent") + 1], "omp");
      assert.equal(starts[0][starts[0].indexOf("--name") + 1], TASK);
    });
  });
});

test("an exited worker with no settled outcome is refused, not advanced", async () => {
  await withTempDir(async (dir) => {
    const { stateDir, logPath } = writeRepo(dir);
    const scenario = {
      "worker-start": { json: { ok: true, result: { dispatchId: "ctx_fake_stuck" } } },
      // Exited, but the outcome is neither `succeeded` nor `failed`, so the
      // adapter's `result` maps it to null and the engine must read the poll as
      // a refusal rather than as a success with a missing exit code.
      "worker-show": {
        json: {
          ok: true,
          result: {
            projection: { liveness: { verdict: "exited" }, outcome: "in_progress" },
          },
        },
      },
    };

    await withFakeOrca({ scenario, logPath }, async () => {
      const overrides = runOverrides();

      const first = await capture(() => run([TASK, "--once", "--cwd", dir], overrides));
      assert.equal(first.code, 0, first.err);
      assert.match(first.out, /yukl run: started at implement/);

      const second = await capture(() => run([TASK, "--once", "--cwd", dir], overrides));
      assert.equal(second.code, 1, "a refused stage is not a clean step");
      assert.doesNotMatch(second.out, /advanced/);
      assert.match(second.out, /yukl run: failed at implement/);

      const events = readEvents(stateDir, TASK).events;
      const done = events.filter(
        (event) => event.type === "stage_done" && event.data.stage === "implement",
      );
      assert.equal(done.length, 0, "implement is never closed");
      const opened = events.filter((event) => event.type === "stage_started");
      assert.equal(opened.length, 1, "the task stays at implement, with its one open start");

      // The engine records a refusal as a `stage_failed` carrying the
      // `runtimeRefused` observation (it never treats the missing exit code as
      // one of its own).
      const failed = events.filter(
        (event) => event.type === "stage_failed" && event.data.stage === "implement",
      );
      assert.equal(failed.length, 1, "one stage_failed is recorded for implement");
      assert.equal(failed[0].data.runtime, "orca");
      assert.deepEqual(failed[0].data.observation, {
        stage: "implement",
        runtimeRefused: true,
      });

      const calls = readCalls(logPath);
      const starts = calls.filter((argv) => argv[1] === "worker-start");
      assert.equal(starts.length, 1, "the refusal never starts a second worker");
      const shows = calls.filter((argv) => argv[1] === "worker-show");
      assert.ok(shows.length > 0, "the poll asked Orca about the recorded handle");
      assert.equal(shows[0][shows[0].indexOf("--dispatch") + 1], "ctx_fake_stuck");
    });
  });
});

test("a failed worker-start over the real adapter stops the named dispatch and records stage_failed", async () => {
  await withTempDir(async (dir) => {
    const { stateDir, logPath } = writeRepo(dir);
    // worker-start exits 1 but still names the worker it created: the adapter
    // must stop that dispatch before it throws, and the engine must record the
    // refused start rather than leave it invisible.
    const scenario = {
      "worker-start": {
        exitCode: 1,
        json: {
          ok: false,
          result: {
            dispatchId: "ctx_fake_residual",
            stage: "starting",
            residualResources: [{ kind: "worker", dispatchId: "ctx_fake_residual" }],
          },
        },
      },
      "worker-stop": { json: { ok: true, result: {} } },
    };

    await withFakeOrca({ scenario, logPath }, async () => {
      const refused = await capture(() => run([TASK, "--once", "--cwd", dir], runOverrides()));
      assert.equal(refused.code, 1, "a refused start is not a clean step");
      assert.match(refused.err, /orca worker-start failed \(exit 1\)/, refused.err);
      assert.match(refused.err, /ctx_fake_residual/, refused.err);
      assert.doesNotMatch(refused.out, /advanced/);

      const events = readEvents(stateDir, TASK).events.filter(
        (event) => event.data?.stage === "implement",
      );
      assert.deepEqual(
        events.map((event) => event.type),
        ["stage_starting", "stage_failed", "decision"],
        "the refused start is opened, failed and diagnosed",
      );
      assert.deepEqual(events[0].data, { stage: "implement", runtime: "orca" });
      assert.equal(events[1].data.runtime, "orca");
      assert.match(events[1].data.observation.startError, /worker-start failed \(exit 1\)/);
      assert.match(events[1].data.observation.startError, /ctx_fake_residual/);
      assert.equal(
        readEvents(stateDir, TASK).events.some(
          (event) => event.type === "stage_done" && event.data.stage === "implement",
        ),
        false,
        "implement is never closed by a refused start",
      );

      const calls = readCalls(logPath);
      const starts = calls.filter((argv) => argv[1] === "worker-start");
      assert.equal(starts.length, 1, "the failed start is never retried");
      const stops = calls.filter((argv) => argv[1] === "worker-stop");
      assert.equal(stops.length, 1, "exactly one worker-stop is logged for the named dispatch");
      assert.equal(stops[0][stops[0].indexOf("--dispatch") + 1], "ctx_fake_residual");
    });
  });
});

test("a failed worker-stop over the real adapter blocks the next run instead of starting a second worker", async () => {
  await withTempDir(async (dir) => {
    const { stateDir, logPath } = writeRepo(dir);
    // worker-start exits 1 and names the worker it created, but worker-stop
    // cannot prove it stopped. The adapter refuses to claim the worker was
    // stopped, so the start's outcome is unknown: the engine records
    // `stage_start_unknown` with no diagnosis, and the next run blocks for a
    // human rather than starting a second worker beside a possibly live one.
    const scenario = {
      "worker-start": {
        exitCode: 1,
        json: {
          ok: false,
          result: {
            dispatchId: "ctx_fake_residual",
            stage: "starting",
            residualResources: [{ kind: "worker", dispatchId: "ctx_fake_residual" }],
          },
        },
      },
      "worker-stop": { exitCode: 1, stderr: "stop refused" },
    };

    await withFakeOrca({ scenario, logPath }, async () => {
      const overrides = runOverrides();

      const refused = await capture(() => run([TASK, "--once", "--cwd", dir], overrides));
      assert.equal(refused.code, 1, "an unknown start outcome is not a clean step");
      assert.match(refused.err, /it may still be running/, refused.err);

      const events = readEvents(stateDir, TASK).events.filter(
        (event) => event.data?.stage === "implement",
      );
      assert.deepEqual(
        events.map((event) => event.type),
        ["stage_starting", "stage_start_unknown"],
        "the unknown start is opened and recorded, with no stage_failed and no decision",
      );
      assert.equal(events[1].data.runtime, "orca");
      assert.match(events[1].data.observation.startError, /may still be running/);
      assert.equal(
        readEvents(stateDir, TASK).events.some(
          (event) => event.type === "decision" || event.type === "stage_failed",
        ),
        false,
        "an unknown outcome is never diagnosed as a failure",
      );

      const blocked = await capture(() => run([TASK, "--once", "--cwd", dir], overrides));
      assert.equal(blocked.code, 0, blocked.err);
      assert.match(blocked.out, /yukl run: blocked at implement \(R-NEEDS-HUMAN\)/);
      assert.doesNotMatch(blocked.out, /advanced/);

      const calls = readCalls(logPath);
      const starts = calls.filter((argv) => argv[1] === "worker-start");
      assert.equal(starts.length, 1, "the blocked run never starts a second worker");
      const stops = calls.filter((argv) => argv[1] === "worker-stop");
      assert.equal(stops.length, 1, "the adapter tries the stop exactly once");
      assert.equal(stops[0][stops[0].indexOf("--dispatch") + 1], "ctx_fake_residual");
    });
  });
});

// ---------------------------------------------------------------------------
// the worker's own commit: the anchor and path enforcement follow its worktree
// ---------------------------------------------------------------------------

/** Write `relPath` under `dir`, creating the parent directories. */
function writeTreeFile(dir, relPath, content = "x") {
  const target = join(dir, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** The 40-hex commit `ref` resolves to in the checkout at `cwd`. */
function revParse(cwd, ref) {
  const result = spawnSync("git", [...GIT_IDENTITY, "rev-parse", ref], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git rev-parse ${ref} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** The intent the run enforces, written at branch `main` and read from there. */
function workerIntent(allowedPaths) {
  return [
    "intent:",
    '  goal: "A worker commit judged in its own worktree."',
    "  scope:",
    "    allowed_paths:",
    ...allowedPaths.map((p) => `      - "${p}"`),
    "consultation:",
    "  requires_human_approval: false",
    "",
  ].join("\n");
}

/**
 * Build a temp repository whose branch `main` carries an intent for TASK, plus
 * a second git worktree - the "worker" - branched from `main`. The worker
 * commits there, and the fake Orca worker record reports that worktree, so the
 * run must judge the worker's commit rather than the orchestrator checkout's
 * (an Orca worker commits in its own worktree; see experiment E6).
 */
function writeWorkerRepo(dir, { allowedPaths }) {
  mkdirSync(join(dir, "scripts", "adapters"), { recursive: true });
  writeFileSync(join(dir, "scripts", "adapters", "orca.js"), ORCA_ADAPTER_SHIM);
  writeFileSync(join(dir, "scripts", "adapters", "vcs-github.js"), VCS_ADAPTER);
  writeFileSync(join(dir, "yukl.config.json"), `${JSON.stringify(BASE_CONFIG, null, 2)}\n`);
  writeFileSync(
    join(dir, "yukl.policy.json"),
    readFileSync(join(ROOT, "yukl.policy.json"), "utf8"),
  );
  mkdirSync(join(dir, ".orchestration", "intents"), { recursive: true });
  writeFileSync(join(dir, ".orchestration", "intents", `${TASK}.yml`), workerIntent(allowedPaths));
  git(["-c", "init.defaultBranch=main", "init", "-q"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "seed"], dir);

  const stateDir = join(dir, ".orchestration", "state");
  for (const [stage, to] of SEED_TO_IMPLEMENT) {
    appendEvent(stateDir, TASK, {
      type: "stage_done",
      actor: SEED_ACTORS[stage] ?? "seed",
      anchor: { path: `${stage}.md`, commit: SEED_COMMIT },
      data: { stage, to },
    });
  }

  const workerDir = join(dir, ".orchestration", "worker");
  git(["worktree", "add", "-q", "-b", "worker", workerDir], dir);
  return { stateDir, logPath: join(dir, "calls.log"), workerDir };
}

/** The worker record that names `worktreeDir` as the checkout the worker ran in. */
function workerShown(worktreeDir) {
  return {
    json: {
      ok: true,
      result: {
        terminal: { worktreePath: worktreeDir },
        projection: { liveness: { verdict: "exited" }, outcome: "succeeded" },
      },
    },
  };
}

test("an out-of-scope commit in the worker's worktree is stopped by path enforcement", async () => {
  await withTempDir(async (dir) => {
    const { stateDir, logPath, workerDir } = writeWorkerRepo(dir, { allowedPaths: ["src/**"] });
    // The worker commits outside the intent's allowed_paths. The orchestrator
    // checkout stays on `main`, so enforcement against its branch would diff
    // `main...main` - nothing - and pass silently.
    writeTreeFile(workerDir, "outside/evil.js");
    git(["add", "-A"], workerDir);
    git(["commit", "-q", "-m", "out of scope"], workerDir);
    const workerHead = revParse(workerDir, "HEAD");

    const scenario = {
      "worker-start": { json: { ok: true, result: { dispatchId: "ctx_fake_worker" } } },
      // The id form exercises the `<repoId>::<path>` fallback of the adapter.
      "worker-show": {
        json: {
          ok: true,
          result: {
            worker: { worktreeId: `repo_1::${workerDir}` },
            projection: { liveness: { verdict: "exited" }, outcome: "succeeded" },
          },
        },
      },
    };

    await withFakeOrca({ scenario, logPath }, async () => {
      const overrides = runOverrides();
      const first = await capture(() => run([TASK, "--once", "--cwd", dir], overrides));
      assert.equal(first.code, 0, first.err);
      assert.match(first.out, /yukl run: started at implement/);

      const second = await capture(() =>
        run([TASK, "--once", "--base", "main", "--cwd", dir], overrides),
      );
      assert.equal(second.code, 1, "an out-of-scope worker commit is not a clean step");
      assert.match(second.out, /R-PATH-SCOPE/);
      assert.doesNotMatch(second.out, /advanced/);

      const events = readEvents(stateDir, TASK).events;
      const enforcement = events.filter((event) => event.type === "enforcement");
      assert.equal(enforcement.length, 1, "one enforcement event is recorded");
      assert.equal(enforcement[0].data.stage, "implement");
      assert.equal(enforcement[0].data.rule, "R-PATH-SCOPE");
      assert.ok(
        enforcement[0].data.violations.some((v) =>
          /outside\/evil\.js matches no allowed_paths/.test(v),
        ),
        JSON.stringify(enforcement[0].data.violations),
      );
      assert.equal(
        events.some((event) => event.type === "stage_done" && event.data.stage === "implement"),
        false,
        "implement is never closed over an out-of-scope worker commit",
      );
      assert.equal(revParse(workerDir, "HEAD"), workerHead, "the worker HEAD is the judged commit");
    });
  });
});

test("an in-scope worker commit advances implement and anchors at the worker's HEAD", async () => {
  await withTempDir(async (dir) => {
    const { stateDir, logPath, workerDir } = writeWorkerRepo(dir, { allowedPaths: ["src/**"] });
    writeTreeFile(workerDir, "src/allowed/worker.js");
    git(["add", "-A"], workerDir);
    git(["commit", "-q", "-m", "in scope"], workerDir);
    const workerHead = revParse(workerDir, "HEAD");
    const orchestratorHead = revParse(dir, "HEAD");
    assert.notEqual(workerHead, orchestratorHead, "the worker and orchestrator HEADs differ");

    const scenario = {
      "worker-start": { json: { ok: true, result: { dispatchId: "ctx_fake_worker" } } },
      "worker-show": workerShown(workerDir),
    };

    await withFakeOrca({ scenario, logPath }, async () => {
      // The real anchors wiring is the subject here, so the anchor override the
      // other integration tests use is dropped: the run must resolve the
      // worker's HEAD itself.
      const overrides = runOverrides();
      delete overrides.anchors;

      const first = await capture(() =>
        run([TASK, "--once", "--base", "main", "--cwd", dir], overrides),
      );
      assert.equal(first.code, 0, first.err);
      assert.match(first.out, /yukl run: started at implement/);

      const second = await capture(() =>
        run([TASK, "--once", "--base", "main", "--cwd", dir], overrides),
      );
      assert.equal(second.code, 0, second.err);
      assert.match(second.out, /yukl run: advanced/);
      assert.match(second.out, /implement -> prove/);

      const events = readEvents(stateDir, TASK).events;
      assert.equal(
        events.some((event) => event.type === "enforcement"),
        false,
        "an in-scope worker commit passes path enforcement",
      );
      const done = events.filter(
        (event) => event.type === "stage_done" && event.data.to === "prove",
      );
      assert.equal(done.length, 1, "exactly one stage_done moves implement to prove");
      assert.equal(done[0].data.stage, "implement");
      assert.equal(
        done[0].anchor.commit,
        workerHead,
        "the anchor is the commit the worker made in its own worktree",
      );
      assert.notEqual(done[0].anchor.commit, orchestratorHead);
    });
  });
});

test("an unresolvable worker workspace blocks instead of anchoring the orchestrator HEAD", async () => {
  for (const base of [null, "main"]) {
    await withTempDir(async (dir) => {
      const { stateDir, logPath } = writeWorkerRepo(dir, { allowedPaths: ["src/**"] });
      // The worker record names no worktree at all: no terminal.worktreePath and
      // no worktreeId carrying a path. The run must block for a human rather
      // than anchor the orchestrator checkout's HEAD.
      const scenario = {
        "worker-start": { json: { ok: true, result: { dispatchId: "ctx_fake_nowhere" } } },
        "worker-show": {
          json: {
            ok: true,
            result: {
              projection: { liveness: { verdict: "exited" }, outcome: "succeeded" },
            },
          },
        },
      };

      await withFakeOrca({ scenario, logPath }, async () => {
        const overrides = runOverrides();
        const args = [TASK, "--once", "--cwd", dir];
        if (base !== null) args.push("--base", base);

        const first = await capture(() => run(args, overrides));
        assert.equal(first.code, 0, first.err);
        assert.match(first.out, /yukl run: started at implement/);

        const second = await capture(() => run(args, overrides));
        assert.equal(second.code, 1, `base ${base}: a blocked stage is not a clean step`);
        assert.match(second.out, /R-NEEDS-HUMAN/);
        assert.doesNotMatch(second.out, /advanced/);

        const events = readEvents(stateDir, TASK).events;
        const enforcement = events.filter((event) => event.type === "enforcement");
        assert.equal(enforcement.length, 1, `base ${base}: one enforcement event is recorded`);
        assert.equal(enforcement[0].data.stage, "implement");
        assert.equal(enforcement[0].data.rule, "R-NEEDS-HUMAN");
        assert.ok(
          enforcement[0].data.violations.some((v) => /worker workspace unresolvable: /.test(v)),
          JSON.stringify(enforcement[0].data.violations),
        );
        assert.equal(
          events.some((event) => event.type === "stage_done" && event.data.stage === "implement"),
          false,
          `base ${base}: implement is never anchored at the orchestrator HEAD`,
        );
      });
    });
  }
});
