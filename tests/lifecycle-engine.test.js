import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeRuntime } from "../scripts/adapters/fake.js";
import { appendEvent, headHash, readEvents } from "../scripts/lifecycle/events.js";
import * as stages from "../scripts/lifecycle/stages.js";
import { runUntilBlocked, step } from "../scripts/lifecycle/engine.js";

const ANCHOR_COMMIT = "a".repeat(40);
const MERGE_SHA = "b".repeat(40);
const GATE_COMMIT = "c".repeat(40);

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-engine-"));
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

/** A runtime that settles with a zero exit code as soon as it is polled. */
function settledRuntime() {
  return {
    name: "stub",
    start({ stage }) {
      return `handle-${stage}`;
    },
    status() {
      return "exited";
    },
    result() {
      return { exitCode: 0 };
    },
    stop() {},
  };
}

/** A full, stubbed environment around the real event log and stage machine. */
function makeDeps(dir, overrides = {}) {
  return {
    events: { dir, readEvents, appendEvent, headHash },
    stages,
    anchors: {
      anchorStage: (stage) => ({
        ok: true,
        anchor: { path: `${stage}.md`, commit: ANCHOR_COMMIT },
      }),
    },
    requiresHuman: () => false,
    runtime: () => settledRuntime(),
    enforce: () => ({ ok: true, violations: [], rule: "R-PATH-SCOPE" }),
    decide: () => ({ kind: "retry" }),
    vcs: { merge: async () => ({ ok: true, sha: MERGE_SHA }) },
    dispatch: (stage, taskId) => ({
      actor: `agent-${stage}`,
      env: { YUKL_DISPATCH_ID: `agent-${stage}` },
      worktree: dir,
      spec: `${taskId}-${stage}`,
    }),
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** Append a valid stage_done event without going through the engine. */
function seedStageDone(dir, taskId, stage, to) {
  appendEvent(dir, taskId, {
    type: "stage_done",
    actor: `agent-${stage}`,
    anchor: { path: `${stage}.md`, commit: ANCHOR_COMMIT },
    data: { stage, to },
  });
}

// ---------------------------------------------------------------------------
// control: with stubbed deps the happy path reaches done
// ---------------------------------------------------------------------------

test("with stubbed deps the happy path reaches done", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-happy";
    const result = await runUntilBlocked({ taskId, deps: makeDeps(dir), maxSteps: 64 });

    assert.equal(result.status, "terminal", "the run must reach a terminal stage");
    assert.equal(result.stage, "done");

    const log = readEvents(dir, taskId);
    const done = log.events.filter((e) => e.type === "stage_done" && e.data.to === "done");
    assert.equal(done.length, 1, "exactly one event moves the lifecycle into done");
    assert.equal(done[0].actor, "agent-integrate");
    assert.equal(done[0].anchor.commit, MERGE_SHA);

    const started = log.events.filter((e) => e.type === "stage_started");
    assert.equal(started.length, 7, "every agent stage is started exactly once");
    assert.deepEqual(
      started.map((e) => e.data.stage),
      ["intent", "scope", "plan", "implement", "prove", "audit", "review"],
    );
    assert.ok(started.every((e) => e.actor === "engine"));

    const next = await step({ taskId, deps: makeDeps(dir) });
    assert.equal(next.status, "terminal");
    assert.equal(next.stage, "done");
  });
});

// ---------------------------------------------------------------------------
// must reject: a crash after start must resume by polling, never by restarting
// ---------------------------------------------------------------------------

test("a crash after start resumes by polling the same handle and starts no second agent", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-crash";
    const fake = createFakeRuntime({ script: [{ exitCode: 0 }] });
    const byId = new Map();
    const runtime = () => ({
      name: "fake",
      start(args) {
        const handle = fake.start(args);
        byId.set(handle.id, handle);
        return handle.id;
      },
      status(id) {
        return fake.status(byId.get(id));
      },
      result(id) {
        return fake.result(byId.get(id));
      },
      stop(id) {
        fake.stop(byId.get(id));
      },
    });

    const started = await step({ taskId, deps: makeDeps(dir, { runtime }) });
    assert.equal(started.status, "started");
    assert.equal(started.stage, "intent");
    assert.equal(fake.startCount, 1);

    // A fresh engine call: a new deps object, the same fake instance and log dir.
    const resumed = await step({ taskId, deps: makeDeps(dir, { runtime }) });
    assert.equal(resumed.status, "advanced");
    assert.equal(resumed.from, "intent");
    assert.equal(resumed.to, "scope");
    assert.equal(fake.startCount, 1, "the recorded handle is polled, not started again");
    assert.equal(fake.starts.length, 1);

    const log = readEvents(dir, taskId);
    assert.deepEqual(
      log.events.map((e) => e.type),
      ["stage_started", "stage_done"],
    );
  });
});

// ---------------------------------------------------------------------------
// must reject: an enforcement refusal blocks the advance to prove
// ---------------------------------------------------------------------------

test("a stubbed enforcement refusal yields an enforcement event and no prove transition", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-enforce";
    const violations = ["src/other.js matches no allowed_paths"];
    const deps = makeDeps(dir, {
      enforce: ({ stage }) =>
        stage === "implement"
          ? { ok: false, rule: "R-PATH-SCOPE", violations }
          : { ok: true, violations: [], rule: "R-PATH-SCOPE" },
    });

    const result = await runUntilBlocked({ taskId, deps, maxSteps: 64 });
    assert.equal(result.status, "blocked");
    assert.equal(result.rule, "R-PATH-SCOPE");
    assert.equal(result.stage, "implement");

    const log = readEvents(dir, taskId);
    const enforcement = log.events.filter((e) => e.type === "enforcement");
    assert.equal(enforcement.length, 1);
    assert.equal(enforcement[0].actor, "engine");
    assert.equal(enforcement[0].data.stage, "implement");
    assert.equal(enforcement[0].data.rule, "R-PATH-SCOPE");
    assert.deepEqual(enforcement[0].data.violations, violations);

    assert.equal(
      log.events.some((e) => e.type === "stage_done" && e.data.to === "prove"),
      false,
      "a refused implementation must never advance to prove",
    );
    const lastDone = log.events.filter((e) => e.type === "stage_done").at(-1);
    assert.equal(lastDone.data.to, "implement", "the lifecycle stays at implement");
  });
});

// ---------------------------------------------------------------------------
// must reject: a stage that needs a human blocks the loop
// ---------------------------------------------------------------------------

test("a requiresHuman refusal stops runUntilBlocked with R-NEEDS-HUMAN", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-human";
    const deps = makeDeps(dir, {
      requiresHuman: (id) => id === stages.advanceId("intent", "scope"),
    });

    const result = await runUntilBlocked({ taskId, deps, maxSteps: 64 });
    assert.equal(result.status, "blocked");
    assert.equal(result.rule, stages.RULES.NEEDS_HUMAN);
    assert.equal(result.stage, "intent");

    const log = readEvents(dir, taskId);
    assert.equal(
      log.events.some((e) => e.type === "stage_done"),
      false,
      "a refused edge must append nothing that advances",
    );
    assert.equal(log.events.filter((e) => e.type === "stage_started").length, 1);
  });
});

// ---------------------------------------------------------------------------
// gate stages complete through the injected check, without a runtime
// ---------------------------------------------------------------------------

test("a gate stage completes through the injected gate check", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-gate";
    const gateCalls = [];
    const deps = makeDeps(dir, {
      runtime: (stage) => (stage === "prove" ? null : settledRuntime()),
      gate: (stage) => {
        gateCalls.push(stage);
        return stage === "prove"
          ? { ok: true, anchor: { path: "proof.md", commit: GATE_COMMIT } }
          : { ok: false };
      },
    });

    const result = await runUntilBlocked({ taskId, deps, maxSteps: 64 });
    assert.equal(result.status, "terminal");
    assert.ok(gateCalls.includes("prove"));

    const log = readEvents(dir, taskId);
    const proveDone = log.events.find((e) => e.type === "stage_done" && e.data.stage === "prove");
    assert.ok(proveDone, "the gate stage must be recorded as done");
    assert.equal(proveDone.data.to, "audit");
    assert.equal(proveDone.anchor.path, "proof.md");
    assert.equal(
      log.events.some((e) => e.type === "stage_started" && e.data.stage === "prove"),
      false,
      "a gate stage starts no runtime",
    );
  });
});

// ---------------------------------------------------------------------------
// integrate merges with the log head as the run head
// ---------------------------------------------------------------------------

test("integrate merges with the log head as the run head", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-integrate";
    const merges = [];
    const deps = makeDeps(dir, {
      dispatch: (stage, taskId_) => ({
        actor: `agent-${stage}`,
        env: { YUKL_DISPATCH_ID: `agent-${stage}` },
        ref: "feature",
        base: "main",
        spec: `${taskId_}-${stage}`,
      }),
      vcs: {
        merge: async (ref, base, options) => {
          merges.push({ ref, base, ...options });
          return { ok: true, sha: MERGE_SHA };
        },
      },
    });

    const result = await runUntilBlocked({ taskId, deps, maxSteps: 64 });
    assert.equal(result.status, "terminal");
    assert.equal(merges.length, 1);
    assert.equal(merges[0].ref, "feature");
    assert.equal(merges[0].base, "main");
    assert.equal(merges[0].runHead.taskId, taskId);

    const log = readEvents(dir, taskId);
    const integrateDone = log.events.find(
      (e) => e.type === "stage_done" && e.data.stage === "integrate",
    );
    assert.ok(integrateDone);
    const before = {
      events: log.events.slice(0, integrateDone.seq),
      lines: log.lines.slice(0, integrateDone.seq),
    };
    assert.equal(
      merges[0].runHead.hash,
      headHash(before),
      "the run head is the log head just before the merge",
    );
  });
});

// ---------------------------------------------------------------------------
// failures are recorded and diagnosed
// ---------------------------------------------------------------------------

test("a failed runtime appends a stage_failed event and a decision event", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-fail";
    const runtime = {
      name: "boom",
      start: () => "handle-boom",
      status: () => "exited",
      result: () => ({ exitCode: 2 }),
      stop() {},
    };
    const seen = [];
    const deps = makeDeps(dir, {
      runtime: () => runtime,
      decide: (observation, history) => {
        seen.push({ observation, history });
        return { kind: "retry", rule: "R-DIAGNOSE" };
      },
    });

    assert.equal((await step({ taskId, deps })).status, "started");
    const failed = await step({ taskId, deps });
    assert.equal(failed.status, "failed");
    assert.equal(failed.observation.exitCode, 2);
    assert.equal(failed.decision.kind, "retry");

    assert.equal(seen.length, 1);
    assert.equal(seen[0].observation.exitCode, 2);
    assert.equal(seen[0].history.attempts, 0);

    const log = readEvents(dir, taskId);
    const stageFailed = log.events.find((e) => e.type === "stage_failed");
    assert.equal(stageFailed.actor, "engine");
    assert.equal(stageFailed.data.stage, "intent");
    assert.equal(stageFailed.data.runtime, "boom");
    assert.equal(stageFailed.data.observation.exitCode, 2);

    const decision = log.events.find((e) => e.type === "decision");
    assert.equal(decision.actor, "engine");
    assert.deepEqual(decision.decision, { kind: "retry", rule: "R-DIAGNOSE" });
    assert.deepEqual(decision.data, { stage: "intent", attempt: 1 });
  });
});

test("an escalation decision stops runUntilBlocked", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-escalate";
    const runtime = {
      name: "boom",
      start: () => "handle-boom",
      status: () => "exited",
      result: () => ({ exitCode: 1 }),
      stop() {},
    };
    const deps = makeDeps(dir, {
      runtime: () => runtime,
      decide: () => ({ kind: "escalate", rule: "R-DIAGNOSE" }),
    });

    const result = await runUntilBlocked({ taskId, deps, maxSteps: 64 });
    assert.equal(result.status, "escalated");
    assert.equal(result.stage, "intent");
  });
});

test("a live runtime blocks the loop without starting a second agent", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-live";
    let starts = 0;
    const runtime = {
      name: "slow",
      start: () => {
        starts += 1;
        return "handle-slow";
      },
      status: () => "live",
      result: () => null,
      stop() {},
    };
    const deps = makeDeps(dir, { runtime: () => runtime });

    const result = await runUntilBlocked({ taskId, deps, maxSteps: 64 });
    assert.equal(result.status, "waiting");
    assert.equal(result.stage, "intent");
    assert.equal(starts, 1);
  });
});

// ---------------------------------------------------------------------------
// replay honours reopen and human_decision events from the log
// ---------------------------------------------------------------------------

test("a reopen event rewinds the replayed state to its target stage", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-reopen";
    for (const [stage, to] of [
      ["intent", "scope"],
      ["scope", "plan"],
      ["plan", "implement"],
      ["implement", "prove"],
      ["prove", "audit"],
      ["audit", "review"],
    ]) {
      seedStageDone(dir, taskId, stage, to);
    }
    appendEvent(dir, taskId, {
      type: "reopen",
      actor: "engine",
      decision: { kind: "deterministic", rule: "R-REOPEN" },
      data: { from: "review", to: "plan", finding: { target: "plan" } },
    });

    const outcome = await step({ taskId, deps: makeDeps(dir) });
    assert.equal(outcome.status, "started");
    assert.equal(outcome.stage, "plan", "the replayed state is back at plan");
  });
});

test("a reopen out of the terminal done state rewinds by direct fallback", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-reopen-done";
    for (const [stage, to] of [
      ["intent", "scope"],
      ["scope", "plan"],
      ["plan", "implement"],
      ["implement", "prove"],
      ["prove", "audit"],
      ["audit", "review"],
      ["review", "integrate"],
      ["integrate", "done"],
    ]) {
      seedStageDone(dir, taskId, stage, to);
    }
    appendEvent(dir, taskId, {
      type: "reopen",
      actor: "engine",
      decision: { kind: "deterministic", rule: "R-REOPEN" },
      data: { from: "done", to: "plan", finding: { target: "plan" } },
    });

    const outcome = await step({ taskId, deps: makeDeps(dir) });
    assert.equal(outcome.status, "started");
    assert.equal(outcome.stage, "plan");
  });
});

test("a persisted human_decision stop replays to the stopped terminal state", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-stop";
    appendEvent(dir, taskId, {
      type: "human_decision",
      actor: "human:alice",
      data: { decision: "stop", action: "stop", to: "stopped" },
    });

    const outcome = await step({ taskId, deps: makeDeps(dir) });
    assert.equal(outcome.status, "terminal");
    assert.equal(outcome.stage, "stopped");
  });
});

// ---------------------------------------------------------------------------
// input validation
// ---------------------------------------------------------------------------

test("runUntilBlocked refuses a non-positive maxSteps", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      runUntilBlocked({ taskId: "task-max", deps: makeDeps(dir), maxSteps: 0 }),
      /maxSteps/,
    );
  });
});

test("step refuses deps without the event log or stage machine", async () => {
  await assert.rejects(step({ taskId: "task-deps", deps: {} }), /deps\.events/);
  await assert.rejects(
    step({
      taskId: "task-deps",
      deps: { events: { dir: ".", readEvents() {}, appendEvent() {} } },
    }),
    /deps\.stages/,
  );
});
