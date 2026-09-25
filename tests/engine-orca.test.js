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
    const scenarioPath = join(dir, "scenario.json");
    writeFileSync(
      scenarioPath,
      JSON.stringify({
        "worker-start": { json: { ok: true, result: { dispatchId: "ctx_fake_1" } } },
        "worker-show": {
          json: {
            ok: true,
            result: {
              projection: { liveness: { verdict: "exited" }, outcome: "succeeded" },
            },
          },
        },
      }),
    );

    const savedLog = process.env.FAKE_ORCA_LOG;
    const savedScenario = process.env.FAKE_ORCA_SCENARIO;
    process.env.FAKE_ORCA_LOG = logPath;
    process.env.FAKE_ORCA_SCENARIO = scenarioPath;

    try {
      const overrides = {
        createRuntime: (entry) =>
          createOrcaRuntime({
            orca: [process.execPath, FAKE_ORCA],
            agent: entry.agent,
          }),
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
    } finally {
      if (savedLog === undefined) delete process.env.FAKE_ORCA_LOG;
      else process.env.FAKE_ORCA_LOG = savedLog;
      if (savedScenario === undefined) delete process.env.FAKE_ORCA_SCENARIO;
      else process.env.FAKE_ORCA_SCENARIO = savedScenario;
    }
  });
});
