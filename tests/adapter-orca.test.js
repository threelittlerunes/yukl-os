import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOrcaRuntime } from "../scripts/adapters/orca.js";
import { assertRuntime, implementsRuntime } from "../scripts/lifecycle/runtime.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fixtures", "fake-orca", "fake-orca.js");

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-orca-"));
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
 * Run `fn` with a fake-orca runtime wired to `scenario`. The fake records to
 * `<dir>/calls.log` and answers from `<dir>/scenario.json`; the two env vars
 * the fake reads are set for the duration and restored afterwards.
 */
async function withFake(dir, scenario, fn) {
  const scenarioPath = join(dir, "scenario.json");
  const logPath = join(dir, "calls.log");
  writeFileSync(scenarioPath, JSON.stringify(scenario));

  const savedLog = process.env.FAKE_ORCA_LOG;
  const savedScenario = process.env.FAKE_ORCA_SCENARIO;
  process.env.FAKE_ORCA_LOG = logPath;
  process.env.FAKE_ORCA_SCENARIO = scenarioPath;

  const runtime = createOrcaRuntime({
    orca: [process.execPath, FAKE],
    agent: "omp",
    baseBranch: "main",
    name: "test-worker",
  });

  try {
    return await fn(runtime, { logPath, scenarioPath });
  } finally {
    restoreEnv("FAKE_ORCA_LOG", savedLog);
    restoreEnv("FAKE_ORCA_SCENARIO", savedScenario);
  }
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function readCalls(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function shown(reply) {
  return { "worker-show": reply };
}

// ---------------------------------------------------------------------------
// interface and argument array
// ---------------------------------------------------------------------------

test("the adapter implements the runtime interface", () => {
  const runtime = createOrcaRuntime({ orca: "orca", agent: "omp", baseBranch: "main" });
  assert.equal(implementsRuntime(runtime), true);
  assert.equal(assertRuntime(runtime), runtime);
});

test("start passes the plan's argument array to worker-start and returns the dispatch id", async () => {
  await withTempDir(async (dir) => {
    await withFake(
      dir,
      {
        "worker-start": {
          json: { ok: true, result: { dispatchId: "ctx_fake_1", state: "ready" } },
        },
      },
      async (runtime, { logPath }) => {
        const handle = runtime.start({
          stage: "expert-power-drafter",
          taskId: "v2-w2-orca-adapter",
          spec: "implement the orca adapter",
        });
        assert.deepEqual(handle, { dispatchId: "ctx_fake_1" });

        const calls = readCalls(logPath);
        assert.equal(calls.length, 1, "worker-start is called exactly once");
        assert.deepEqual(calls[0], [
          "orchestration",
          "worker-start",
          "--spec",
          "implement the orca adapter",
          "--worktree",
          "new-top-level",
          "--name",
          "test-worker",
          "--base-branch",
          "main",
          "--agent",
          "omp",
          "--json",
        ]);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// must-reject: failed starts
// ---------------------------------------------------------------------------

test("a non-zero worker-start fails and is never retried", async () => {
  await withTempDir(async (dir) => {
    await withFake(
      dir,
      { "worker-start": { exitCode: 1, stderr: "no Orca runtime" } },
      async (runtime, { logPath }) => {
        assert.throws(
          () => runtime.start({ taskId: "t", spec: "s" }),
          /orca worker-start failed \(exit 1\)/,
        );
        assert.equal(readCalls(logPath).length, 1, "a failed start must not be retried");
      },
    );
  });
});

test("an ok:false worker-start envelope fails even with exit 0", async () => {
  await withTempDir(async (dir) => {
    await withFake(
      dir,
      { "worker-start": { json: { ok: false, result: {} } } },
      async (runtime, { logPath }) => {
        assert.throws(() => runtime.start({ taskId: "t", spec: "s" }), /worker-start failed/);
        assert.equal(readCalls(logPath).length, 1);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// status mapping
// ---------------------------------------------------------------------------

const STATUS_CASES = [
  {
    name: 'the literal "live" verdict maps to live',
    reply: { json: { ok: true, result: { projection: { liveness: { verdict: "live" } } } } },
    expected: "live",
  },
  {
    name: 'the literal "exited" verdict maps to exited',
    reply: { json: { ok: true, result: { projection: { liveness: { verdict: "exited" } } } } },
    expected: "exited",
  },
  {
    name: "a missing liveness field is unverifiable, never exited",
    reply: { json: { ok: true, result: { projection: { outcome: "in_progress" } } } },
    expected: "unverifiable",
  },
  {
    name: "an unknown verdict is unverifiable",
    reply: { json: { ok: true, result: { projection: { liveness: { verdict: "waiting" } } } } },
    expected: "unverifiable",
  },
  {
    name: "unparseable JSON is unverifiable",
    reply: { stdout: "not json at all" },
    expected: "unverifiable",
  },
  {
    name: "a non-zero worker-show is unverifiable",
    reply: {
      exitCode: 1,
      json: { ok: true, result: { projection: { liveness: { verdict: "live" } } } },
    },
    expected: "unverifiable",
  },
  {
    name: "an ok:false worker-show is unverifiable",
    reply: { json: { ok: false, result: {} } },
    expected: "unverifiable",
  },
];

for (const scenarioCase of STATUS_CASES) {
  test(`status: ${scenarioCase.name}`, async () => {
    await withTempDir(async (dir) => {
      await withFake(dir, shown(scenarioCase.reply), async (runtime) => {
        assert.equal(runtime.status({ dispatchId: "ctx_fake_1" }), scenarioCase.expected);
      });
    });
  });
}

test("status of a foreign handle is unverifiable and calls no Orca command", async () => {
  await withTempDir(async (dir) => {
    await withFake(dir, shown({ json: { ok: true, result: {} } }), async (runtime, { logPath }) => {
      assert.equal(runtime.status(null), "unverifiable");
      assert.equal(runtime.status({}), "unverifiable");
      assert.equal(runtime.status({ id: "not-mine" }), "unverifiable");
      assert.deepEqual(readCalls(logPath), []);
    });
  });
});

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------

const RESULT_CASES = [
  {
    name: "a settled succeeded outcome is returned",
    reply: { json: { ok: true, result: { projection: { outcome: "succeeded" } } } },
    expected: "succeeded",
  },
  {
    name: "a settled failed outcome is returned",
    reply: { json: { ok: true, result: { projection: { outcome: "failed" } } } },
    expected: "failed",
  },
  {
    name: "an in_progress outcome means not settled",
    reply: { json: { ok: true, result: { projection: { outcome: "in_progress" } } } },
    expected: null,
  },
  {
    name: "a missing outcome means not settled",
    reply: { json: { ok: true, result: { projection: {} } } },
    expected: null,
  },
  {
    name: "unparseable JSON means not settled",
    reply: { stdout: "{ broken" },
    expected: null,
  },
];

for (const scenarioCase of RESULT_CASES) {
  test(`result: ${scenarioCase.name}`, async () => {
    await withTempDir(async (dir) => {
      await withFake(dir, shown(scenarioCase.reply), async (runtime) => {
        assert.equal(runtime.result({ dispatchId: "ctx_fake_1" }), scenarioCase.expected);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

test("stop fences the dispatch through worker-stop", async () => {
  await withTempDir(async (dir) => {
    await withFake(
      dir,
      { "worker-stop": { json: { ok: true, result: {} } } },
      async (runtime, { logPath }) => {
        runtime.stop({ dispatchId: "ctx_fake_1" });
        assert.deepEqual(readCalls(logPath), [
          ["orchestration", "worker-stop", "--dispatch", "ctx_fake_1", "--json"],
        ]);
      },
    );
  });
});

test("stop ignores a foreign handle and calls no Orca command", async () => {
  await withTempDir(async (dir) => {
    await withFake(dir, { "worker-stop": { json: { ok: true } } }, async (runtime, { logPath }) => {
      runtime.stop({});
      runtime.stop(null);
      runtime.stop({ id: "not-mine" });
      assert.deepEqual(readCalls(logPath), []);
    });
  });
});
