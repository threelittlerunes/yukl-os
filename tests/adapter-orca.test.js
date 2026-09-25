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
        assert.equal(handle, "ctx_fake_1", "the handle is the dispatch id string itself");

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

test("start omits --base-branch entirely when no base is configured", async () => {
  const OMITTED = [undefined, null, ""];
  for (const base of OMITTED) {
    await withTempDir(async (dir) => {
      const scenarioPath = join(dir, "scenario.json");
      const logPath = join(dir, "calls.log");
      writeFileSync(
        scenarioPath,
        JSON.stringify({
          "worker-start": { json: { ok: true, result: { dispatchId: "ctx_fake_1" } } },
        }),
      );

      const savedLog = process.env.FAKE_ORCA_LOG;
      const savedScenario = process.env.FAKE_ORCA_SCENARIO;
      process.env.FAKE_ORCA_LOG = logPath;
      process.env.FAKE_ORCA_SCENARIO = scenarioPath;
      try {
        const runtime = createOrcaRuntime({
          orca: [process.execPath, FAKE],
          agent: "omp",
          baseBranch: base,
          name: "test-worker",
        });
        runtime.start({ taskId: "t", spec: "s" });

        const calls = readCalls(logPath);
        assert.equal(calls.length, 1);
        assert.deepEqual(
          calls[0],
          [
            "orchestration",
            "worker-start",
            "--spec",
            "s",
            "--worktree",
            "new-top-level",
            "--name",
            "test-worker",
            "--agent",
            "omp",
            "--json",
          ],
          `baseBranch ${JSON.stringify(base)} must omit the flag pair, not pass an empty value`,
        );
        assert.equal(
          calls[0].includes("--base-branch"),
          false,
          "no --base-branch may reach Orca without a base",
        );
      } finally {
        restoreEnv("FAKE_ORCA_LOG", savedLog);
        restoreEnv("FAKE_ORCA_SCENARIO", savedScenario);
      }
    });
  }
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

test("a failed worker-start that names a dispatch stops it before throwing", async () => {
  const scenarios = [
    {
      name: "result.dispatchId names the worker",
      reply: {
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
      id: "ctx_fake_residual",
    },
    {
      name: "only a residualResources entry names the worker",
      reply: {
        exitCode: 1,
        json: {
          ok: false,
          result: {
            stage: "starting",
            residualResources: [{ kind: "worker", id: "ctx_fake_left" }],
          },
        },
      },
      id: "ctx_fake_left",
    },
  ];

  for (const scenarioCase of scenarios) {
    await withTempDir(async (dir) => {
      await withFake(
        dir,
        { "worker-start": scenarioCase.reply, "worker-stop": { json: { ok: true, result: {} } } },
        async (runtime, { logPath }) => {
          assert.throws(
            () => runtime.start({ taskId: "t", spec: "s" }),
            (err) => {
              assert.match(err.message, /worker-start failed \(exit 1\)/);
              assert.match(err.message, new RegExp(scenarioCase.id));
              assert.match(err.message, /residualResources/);
              return true;
            },
            `${scenarioCase.name} must throw`,
          );
          const calls = readCalls(logPath);
          const stops = calls.filter((argv) => argv[1] === "worker-stop");
          assert.equal(stops.length, 1, `${scenarioCase.name}: exactly one worker-stop`);
          assert.deepEqual(stops[0], [
            "orchestration",
            "worker-stop",
            "--dispatch",
            scenarioCase.id,
            "--json",
          ]);
        },
      );
    });
  }
});

test("a failed worker-stop leaves the start outcome unknown and never claims the worker stopped", async () => {
  // worker-start fails and names the worker it created, but worker-stop cannot
  // prove it stopped: each shape must throw an error that says the worker may
  // still be running and carries `startOutcomeUnknown`, never "stopped".
  const stopFailures = [
    {
      name: "worker-stop exits non-zero",
      reply: { exitCode: 3, stderr: "no such worker" },
      reason: /worker-stop exit 3/,
    },
    {
      name: "worker-stop replies ok: false",
      reply: { json: { ok: false, result: { error: "cannot stop" } } },
      reason: /worker-stop replied ok: false/,
    },
    {
      name: "worker-stop replies unparseable output",
      reply: { stdout: "stop: not json\n" },
      reason: /unparseable worker-stop reply/,
    },
  ];

  for (const stopCase of stopFailures) {
    await withTempDir(async (dir) => {
      await withFake(
        dir,
        {
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
          "worker-stop": stopCase.reply,
        },
        async (runtime, { logPath }) => {
          assert.throws(
            () => runtime.start({ taskId: "t", spec: "s" }),
            (err) => {
              assert.equal(
                err.startOutcomeUnknown,
                true,
                `${stopCase.name}: outcome stays unknown`,
              );
              assert.match(err.message, /ctx_fake_residual/, stopCase.name);
              assert.match(err.message, stopCase.reason, stopCase.name);
              assert.match(err.message, /may still be running/, stopCase.name);
              assert.match(err.message, /residualResources/, stopCase.name);
              assert.equal(
                err.message.includes("stopped residual worker"),
                false,
                `${stopCase.name}: a failed stop is never reported as a stopped worker`,
              );
              return true;
            },
            `${stopCase.name} must throw`,
          );

          const calls = readCalls(logPath);
          const stops = calls.filter((argv) => argv[1] === "worker-stop");
          assert.equal(stops.length, 1, `${stopCase.name}: exactly one worker-stop is called`);
          assert.equal(stops[0][stops[0].indexOf("--dispatch") + 1], "ctx_fake_residual");
        },
      );
    });
  }
});

test("a failed worker-start with no dispatch id stops nothing", async () => {
  await withTempDir(async (dir) => {
    await withFake(
      dir,
      {
        "worker-start": {
          exitCode: 1,
          stderr: "no Orca runtime",
          json: { ok: false, result: { stage: "setup", residualResources: [] } },
        },
      },
      async (runtime, { logPath }) => {
        assert.throws(
          () => runtime.start({ taskId: "t", spec: "s" }),
          /worker-start failed \(exit 1\)/,
        );
        const calls = readCalls(logPath);
        assert.equal(calls.length, 1, "only the failed worker-start is attempted");
        assert.equal(
          calls.some((argv) => argv[1] === "worker-stop"),
          false,
          "a reply that names no worker stops nothing",
        );
      },
    );
  });
});

test("a start without a spec or agent throws and calls no Orca command", async () => {
  await withTempDir(async (dir) => {
    const scenarioPath = join(dir, "scenario.json");
    const logPath = join(dir, "calls.log");
    writeFileSync(
      scenarioPath,
      JSON.stringify({
        "worker-start": { json: { ok: true, result: { dispatchId: "ctx_fake_1" } } },
      }),
    );

    const savedLog = process.env.FAKE_ORCA_LOG;
    const savedScenario = process.env.FAKE_ORCA_SCENARIO;
    process.env.FAKE_ORCA_LOG = logPath;
    process.env.FAKE_ORCA_SCENARIO = scenarioPath;
    try {
      const configured = createOrcaRuntime({
        orca: [process.execPath, FAKE],
        agent: "omp",
        name: "test-worker",
      });
      for (const spec of [null, undefined, "", "   "]) {
        assert.throws(
          () => configured.start({ taskId: "t", spec }),
          /non-empty --spec/,
          `spec ${JSON.stringify(spec)} must be refused`,
        );
      }

      for (const agent of [null, undefined, "", "   "]) {
        const runtime = createOrcaRuntime({
          orca: [process.execPath, FAKE],
          agent,
          name: "test-worker",
        });
        assert.throws(
          () => runtime.start({ taskId: "t", spec: "s" }),
          /non-empty agent/,
          `agent ${JSON.stringify(agent)} must be refused`,
        );
      }

      const unnamed = createOrcaRuntime({ orca: [process.execPath, FAKE], agent: "omp" });
      assert.throws(
        () => unnamed.start({ spec: "s" }),
        /worker name is required/,
        "a start with no name, taskId or stage must be refused",
      );

      assert.deepEqual(readCalls(logPath), [], "no Orca command runs for a refused start");
    } finally {
      restoreEnv("FAKE_ORCA_LOG", savedLog);
      restoreEnv("FAKE_ORCA_SCENARIO", savedScenario);
    }
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
        assert.equal(runtime.status("ctx_fake_1"), scenarioCase.expected);
      });
    });
  });
}

test("status of a foreign handle is unverifiable and calls no Orca command", async () => {
  await withTempDir(async (dir) => {
    await withFake(dir, shown({ json: { ok: true, result: {} } }), async (runtime, { logPath }) => {
      // Only a non-empty string is a handle this adapter produced. The object
      // shape the adapter used to return is foreign now, and must not be
      // accepted back.
      for (const foreign of [null, undefined, {}, "", { id: "not-mine" }, 42, true]) {
        assert.equal(
          runtime.status(foreign),
          "unverifiable",
          `status(${JSON.stringify(foreign)}) must be unverifiable`,
        );
      }
      assert.equal(
        runtime.status({ dispatchId: "ctx_fake_1" }),
        "unverifiable",
        "the old { dispatchId } handle is foreign",
      );
      assert.deepEqual(readCalls(logPath), []);
    });
  });
});

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------

const RESULT_CASES = [
  {
    name: "a settled succeeded outcome is an exit code of 0",
    reply: { json: { ok: true, result: { projection: { outcome: "succeeded" } } } },
    expected: { exitCode: 0 },
  },
  {
    name: "a settled failed outcome is an exit code of 1",
    reply: { json: { ok: true, result: { projection: { outcome: "failed" } } } },
    expected: { exitCode: 1 },
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
    name: "an unknown outcome word is not settled",
    reply: { json: { ok: true, result: { projection: { outcome: "stopped" } } } },
    expected: null,
  },
  {
    name: "unparseable JSON means not settled",
    reply: { stdout: "{ broken" },
    expected: null,
  },
  {
    name: "a non-zero worker-show means not settled",
    reply: {
      exitCode: 1,
      json: { ok: true, result: { projection: { outcome: "succeeded" } } },
    },
    expected: null,
  },
  {
    name: "an ok:false worker-show means not settled",
    reply: { json: { ok: false, result: { projection: { outcome: "succeeded" } } } },
    expected: null,
  },
];

for (const scenarioCase of RESULT_CASES) {
  test(`result: ${scenarioCase.name}`, async () => {
    await withTempDir(async (dir) => {
      await withFake(dir, shown(scenarioCase.reply), async (runtime) => {
        assert.deepEqual(runtime.result("ctx_fake_1"), scenarioCase.expected);
      });
    });
  });
}

test("result of a foreign handle is null and calls no Orca command", async () => {
  await withTempDir(async (dir) => {
    await withFake(
      dir,
      shown({ json: { ok: true, result: { projection: { outcome: "succeeded" } } } }),
      async (runtime, { logPath }) => {
        for (const foreign of [null, undefined, {}, "", { dispatchId: "ctx_fake_1" }, 7]) {
          assert.equal(
            runtime.result(foreign),
            null,
            `result(${JSON.stringify(foreign)}) must be null`,
          );
        }
        assert.deepEqual(readCalls(logPath), []);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

test("stop fences the dispatch through worker-stop", async () => {
  await withTempDir(async (dir) => {
    await withFake(
      dir,
      { "worker-stop": { json: { ok: true, result: {} } } },
      async (runtime, { logPath }) => {
        runtime.stop("ctx_fake_1");
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
      for (const foreign of [null, undefined, {}, "", { dispatchId: "ctx_fake_1" }, 12]) {
        runtime.stop(foreign);
      }
      assert.deepEqual(readCalls(logPath), []);
    });
  });
});
