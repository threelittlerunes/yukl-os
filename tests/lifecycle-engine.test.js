import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeRuntime } from "../scripts/adapters/fake.js";
import { appendEvent, headHash, readEvents, verifyChain } from "../scripts/lifecycle/events.js";
import * as stages from "../scripts/lifecycle/stages.js";
import { RUN_LIMITS, RUN_LIMIT_RULE, runUntilBlocked, step } from "../scripts/lifecycle/engine.js";

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

/** Seed a valid log up to the integrate stage, so integrate is the current stage. */
function seedToIntegrate(dir, taskId) {
  for (const [stage, to] of [
    ["intent", "scope"],
    ["scope", "plan"],
    ["plan", "implement"],
    ["implement", "prove"],
    ["prove", "audit"],
    ["audit", "review"],
    ["review", "integrate"],
  ]) {
    seedStageDone(dir, taskId, stage, to);
  }
}

/** A dispatch context that names the branch and base for integrate. */
function integrateDispatch(stage, taskId) {
  return {
    actor: `agent-${stage}`,
    env: { YUKL_DISPATCH_ID: `agent-${stage}` },
    ref: "feature",
    base: "main",
    spec: `${taskId}-${stage}`,
  };
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
    assert.equal(started.length, 8, "every agent stage and integrate is started exactly once");
    assert.deepEqual(
      started.map((e) => e.data.stage),
      ["intent", "scope", "plan", "implement", "prove", "audit", "review", "integrate"],
    );
    assert.ok(started.every((e) => e.actor === "engine"));
    assert.equal(started.at(-1).data.runtime, "vcs", "integrate is recorded as the vcs runtime");

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
      ["stage_starting", "stage_started", "stage_done"],
      "the start is opened before the runtime call and closed by the handle",
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

test("an enforcement refusal is recorded once across later steps", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-enforce-once";
    const deps = makeDeps(dir, {
      enforce: ({ stage }) =>
        stage === "implement"
          ? { ok: false, rule: "R-PATH-SCOPE", violations: ["nope"] }
          : { ok: true, violations: [], rule: "R-PATH-SCOPE" },
    });

    const stopped = await runUntilBlocked({ taskId, deps, maxSteps: 64 });
    assert.equal(stopped.status, "blocked");
    assert.equal(stopped.stage, "implement");

    const again1 = await step({ taskId, deps });
    const again2 = await step({ taskId, deps });
    assert.equal(again1.status, "enforced");
    assert.equal(again2.status, "enforced");
    assert.equal(again1.rule, "R-PATH-SCOPE");
    assert.deepEqual(again1.violations, ["nope"]);

    const log = readEvents(dir, taskId);
    assert.equal(
      log.events.filter((e) => e.type === "enforcement").length,
      1,
      "later steps must not append a second enforcement event",
    );
    assert.equal(
      log.events.filter((e) => e.type === "stage_started" && e.data.stage === "implement").length,
      1,
      "the refused stage is not started again",
    );
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
      dispatch: integrateDispatch,
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

test("a crash after the integrate merge does not call merge a second time", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-integrate-crash";
    seedToIntegrate(dir, taskId);

    let mergeCalls = 0;
    const crashVcs = {
      merge: async () => {
        mergeCalls += 1;
        throw new Error("crash after merge");
      },
    };
    await assert.rejects(
      step({ taskId, deps: makeDeps(dir, { dispatch: integrateDispatch, vcs: crashVcs }) }),
      /crash after merge/,
    );
    assert.equal(mergeCalls, 1);

    const crashed = readEvents(dir, taskId);
    const marker = crashed.events.find(
      (e) => e.type === "stage_started" && e.data.stage === "integrate",
    );
    assert.ok(marker, "the merge marker is recorded before the merge");
    assert.equal(marker.data.runtime, "vcs");
    assert.equal(marker.data.handle, `merge:${taskId}`);
    assert.equal(
      crashed.events.some((e) => e.type === "stage_done" && e.data.stage === "integrate"),
      false,
      "the crash leaves the integrate stage incomplete",
    );

    let secondMergeCalls = 0;
    const recoveredVcs = {
      merge: async () => {
        secondMergeCalls += 1;
        return { ok: true, sha: MERGE_SHA };
      },
      merged: async () => ({ ok: true, sha: MERGE_SHA }),
    };
    const recovered = await step({
      taskId,
      deps: makeDeps(dir, { dispatch: integrateDispatch, vcs: recoveredVcs }),
    });
    assert.equal(recovered.status, "advanced");
    assert.equal(recovered.to, "done");
    assert.equal(secondMergeCalls, 0, "the confirmed merge must not run a second time");
  });
});

test("an integrate resume the VCS cannot confirm blocks for a human without merging", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-integrate-unverified";
    seedToIntegrate(dir, taskId);
    appendEvent(dir, taskId, {
      type: "stage_started",
      actor: "engine",
      data: { stage: "integrate", runtime: "vcs", handle: `merge:${taskId}` },
    });

    let mergeCalls = 0;
    const deps = makeDeps(dir, {
      dispatch: integrateDispatch,
      vcs: {
        merge: async () => {
          mergeCalls += 1;
          return { ok: true, sha: MERGE_SHA };
        },
      },
    });

    const outcome = await step({ taskId, deps });
    assert.equal(outcome.status, "blocked");
    assert.equal(outcome.rule, stages.RULES.NEEDS_HUMAN);
    assert.equal(mergeCalls, 0, "an unverifiable resume must never merge blindly");
  });
});

test("an integrate merge failure uses the shared observation shape", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-integrate-fail";
    seedToIntegrate(dir, taskId);

    const deps = makeDeps(dir, {
      dispatch: integrateDispatch,
      vcs: { merge: async () => ({ ok: false, error: "merge conflict" }) },
      decide: () => ({ kind: "escalate", rule: "R-DIAGNOSE" }),
    });

    const outcome = await step({ taskId, deps });
    assert.equal(outcome.status, "failed");
    assert.deepEqual(outcome.observation, {
      stage: "integrate",
      runtimeRefused: true,
      detail: "merge conflict",
    });

    const log = readEvents(dir, taskId);
    const failed = log.events.find((e) => e.type === "stage_failed");
    assert.equal(failed.data.runtime, "vcs");
    assert.deepEqual(failed.data.observation, {
      stage: "integrate",
      runtimeRefused: true,
      detail: "merge conflict",
    });
    assert.equal("mergeFailed" in failed.data.observation, false);
    assert.equal("error" in failed.data.observation, false);
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
// start safety: the start is recorded before the runtime call, so a start whose
// outcome is unknown blocks instead of being repeated, and a throwing start is
// recorded and diagnosed like any other failure
// ---------------------------------------------------------------------------

/** A settled runtime that counts its starts, so a test can prove "once". */
function countingRuntime() {
  const runtime = {
    name: "counting",
    startCount: 0,
    start({ stage }) {
      runtime.startCount += 1;
      return `handle-${stage}`;
    },
    status: () => "exited",
    result: () => ({ exitCode: 0 }),
    stop() {},
  };
  return runtime;
}

/** A runtime whose `start` throws, counting every attempt. */
function throwingRuntime(message) {
  const runtime = {
    name: "boom",
    startCount: 0,
    start() {
      runtime.startCount += 1;
      throw new Error(message);
    },
    status: () => "unverifiable",
    result: () => null,
    stop() {},
  };
  return runtime;
}

test("a throwing start is recorded as stage_failed and diagnosed", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-start-throws";
    const runtime = throwingRuntime("worker-start exploded");
    const seen = [];
    const deps = makeDeps(dir, {
      runtime: () => runtime,
      decide: (observation, history) => {
        seen.push({ observation, history });
        return { kind: "retry", rule: "R-DIAGNOSE" };
      },
    });

    // The start error is recorded and diagnosed, then rethrown: the caller
    // still sees the original failure, and the log carries it.
    await assert.rejects(step({ taskId, deps }), /worker-start exploded/);
    assert.equal(runtime.startCount, 1, "the throwing start is attempted once");
    assert.equal(seen.length, 1, "the start error reaches the diagnosis");
    assert.deepEqual(seen[0].observation, { startError: "worker-start exploded" });
    assert.equal(seen[0].history.attempts, 0);

    const log = readEvents(dir, taskId);
    assert.deepEqual(
      log.events.map((e) => e.type),
      ["stage_starting", "stage_failed", "decision"],
    );
    assert.equal(log.events[0].actor, "engine");
    assert.deepEqual(log.events[0].data, { stage: "intent", runtime: "boom" });
    assert.equal(log.events[1].actor, "engine");
    assert.equal(log.events[1].data.stage, "intent");
    assert.equal(log.events[1].data.runtime, "boom");
    assert.deepEqual(log.events[1].data.observation, { startError: "worker-start exploded" });
    assert.equal(log.events[2].actor, "engine");
    assert.deepEqual(log.events[2].decision, { kind: "retry", rule: "R-DIAGNOSE" });
    assert.equal(log.events[2].data.attempt, 1);

    // The recorded stage_failed closes the stage_starting, so the next step is
    // not blocked as an unknown outcome: it starts the stage again, and only
    // because the diagnosis chose retry.
    await assert.rejects(step({ taskId, deps }), /worker-start exploded/);
    assert.equal(runtime.startCount, 2, "the recorded failure is not an unknown start");
  });

  await withTempDir(async (dir) => {
    const taskId = "task-start-escalates";
    const runtime = throwingRuntime("worker-start exploded");
    const deps = makeDeps(dir, {
      runtime: () => runtime,
      decide: () => ({ kind: "escalate", rule: "R-DIAGNOSE" }),
    });

    await assert.rejects(
      runUntilBlocked({ taskId, deps, maxSteps: 64 }),
      /worker-start exploded/,
      "a throwing start aborts the loop with the original error",
    );
    assert.equal(runtime.startCount, 1, "the loop never retries a throwing start on its own");
    const decision = readEvents(dir, taskId).events.find((e) => e.type === "decision");
    assert.equal(decision.decision.kind, "escalate", "the escalation is the recorded diagnosis");
  });
});

test("a start with unknown outcome blocks with R-NEEDS-HUMAN and starts nothing", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-start-unknown";
    appendEvent(dir, taskId, {
      type: "stage_starting",
      actor: "engine",
      data: { stage: "intent", runtime: "boom" },
    });
    const runtime = countingRuntime();
    const deps = makeDeps(dir, { runtime: () => runtime });

    const outcome = await step({ taskId, deps });
    assert.equal(outcome.status, "blocked");
    assert.equal(outcome.rule, stages.RULES.NEEDS_HUMAN);
    assert.equal(outcome.stage, "intent");
    assert.equal(runtime.startCount, 0, "an unknown start is never repeated");

    const result = await runUntilBlocked({ taskId, deps, maxSteps: 64 });
    assert.equal(result.status, "blocked", "the loop stops on the unknown start too");
    assert.equal(result.rule, stages.RULES.NEEDS_HUMAN);
    assert.equal(result.stage, "intent");
    assert.equal(runtime.startCount, 0);
    assert.deepEqual(
      readEvents(dir, taskId).events.map((e) => e.type),
      ["stage_starting"],
      "the block records nothing that advances",
    );
  });
});

test("a human_decision naming the stage clears the unknown start so the next step starts once", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-start-human";
    appendEvent(dir, taskId, {
      type: "stage_starting",
      actor: "engine",
      data: { stage: "intent", runtime: "boom" },
    });
    // The event `yukl decide override --task <id> --to intent --by <name>
    // --reason <text>` persists: the decision names the stage it keeps.
    appendEvent(dir, taskId, {
      type: "human_decision",
      actor: "human:alice",
      data: {
        decision: "override",
        by: "alice",
        reason: "the unknown start is resolved",
        appliedAtSeq: 1,
        to: "intent",
      },
    });

    const runtime = countingRuntime();
    const outcome = await step({ taskId, deps: makeDeps(dir, { runtime: () => runtime }) });
    assert.equal(outcome.status, "started");
    assert.equal(outcome.stage, "intent");
    assert.equal(outcome.handle, "handle-intent");
    assert.equal(runtime.startCount, 1, "the stage is started exactly once after the decision");
    assert.deepEqual(
      readEvents(dir, taskId).events.map((e) => e.type),
      ["stage_starting", "human_decision", "stage_starting", "stage_started"],
      "the cleared start is closed and the new one is opened and recorded",
    );
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
// unattended runs: wait for a running stage instead of stopping on it, and
// stop only on the lifecycle's own terms or a breached run limit
// ---------------------------------------------------------------------------

/**
 * A runtime that reports `live` for its first `polls` polls and then exits 0.
 * `startCount` counts the handles it handed out, so a test can prove a waiting
 * stage is polled rather than restarted.
 */
function slowRuntime(polls) {
  const runtime = {
    name: "slow",
    startCount: 0,
    pollsLeft: polls,
    start() {
      runtime.startCount += 1;
      return `handle-${runtime.startCount}`;
    },
    status() {
      if (runtime.pollsLeft > 0) {
        runtime.pollsLeft -= 1;
        return "live";
      }
      return "exited";
    },
    result() {
      return { exitCode: 0 };
    },
    stop() {},
  };
  return runtime;
}

/** A deps whose clock moves one minute per sleep, so a wall limit is reachable. */
function tickingDeps(dir, runtime, state) {
  return makeDeps(dir, {
    runtime: () => runtime,
    clock: () => new Date(Date.parse("2026-01-01T00:00:00.000Z") + state.minutes * 60_000),
  });
}

/**
 * A fake sleep for the unattended loop that fails the test instead of hanging.
 * A poll of an unsettled stage resolves as a microtask, so a regression that
 * leaves the loop with no exit - a run limit that never fires - spins without
 * ever yielding to the event loop, and the runner's own timeout (a timer in the
 * same process) can never fire. Throwing after a generous number of polls turns
 * that hang into a fast failure; these tests poll a handful of times.
 */
function boundedSleep(onPoll, maxPolls = 1000) {
  let polls = 0;
  return async () => {
    polls += 1;
    if (polls > maxPolls) {
      throw new Error(`the unattended loop polled ${maxPolls} times without stopping`);
    }
    onPoll(polls);
  };
}

test("an unattended run waits for a running stage and never restarts it", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-unattended-wait";
    const runtime = slowRuntime(4);
    const state = { minutes: 0 };
    const deps = tickingDeps(dir, runtime, state);

    // Attended: a live stage stops the run immediately, as it always has.
    const attended = await runUntilBlocked({ taskId, deps, maxSteps: 64 });
    assert.equal(attended.status, "waiting");
    assert.equal(attended.stage, "intent");
    assert.equal(runtime.startCount, 1);

    // Unattended: the same live stage is polled until it settles, and the run
    // then drives the task to its terminal stage.
    const slept = [];
    const result = await runUntilBlocked({
      taskId,
      deps,
      unattended: true,
      limits: { maxWallMinutesPerRun: 30, maxAgentStartsPerRun: 20 },
      pollIntervalMs: 5,
      sleep: boundedSleep(() => {
        state.minutes += 1;
        slept.push(state.minutes);
      }),
    });

    assert.equal(result.status, "terminal");
    assert.equal(result.stage, "done");
    assert.ok(slept.length >= 2, "the unattended run waited for the running stage");
    assert.equal(
      runtime.startCount,
      7,
      "every agent stage is started exactly once: a polled handle is never restarted",
    );
    assert.deepEqual(
      readEvents(dir, taskId)
        .events.filter((event) => event.type === "enforcement")
        .map((event) => event.data.rule),
      [],
      "waiting is not an enforcement",
    );
    const started = readEvents(dir, taskId).events.filter(
      (event) => event.type === "stage_started",
    );
    assert.equal(started.length, 8, "seven agent starts plus the integrate merge marker");
    assert.equal(
      started.filter((event) => event.data.runtime !== "vcs").length,
      7,
      "no handle is recorded twice",
    );
  });
});

test("an unattended run stops when its wall-clock limit is breached while it waits", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-unattended-wall";
    const runtime = slowRuntime(Number.POSITIVE_INFINITY);
    const state = { minutes: 0 };
    const deps = tickingDeps(dir, runtime, state);

    const result = await runUntilBlocked({
      taskId,
      deps,
      unattended: true,
      limits: { maxWallMinutesPerRun: 10, maxAgentStartsPerRun: 50 },
      pollIntervalMs: 5,
      sleep: boundedSleep(() => {
        state.minutes += 5;
      }),
    });

    assert.equal(result.status, "limit");
    assert.equal(result.rule, RUN_LIMIT_RULE);
    assert.equal(result.stage, "intent");
    assert.deepEqual(result.limit, { name: RUN_LIMITS.WALL, max: 10, observed: 10 });
    assert.equal(result.steps.at(-1).status, "waiting", "the breach stopped the loop waiting");

    const log = readEvents(dir, taskId);
    const enforcement = log.events.filter((event) => event.type === "enforcement");
    assert.equal(enforcement.length, 1, "the breach is recorded exactly once");
    assert.equal(enforcement[0].actor, "engine");
    assert.deepEqual(enforcement[0].data, {
      stage: "intent",
      rule: RUN_LIMIT_RULE,
      limit: { name: RUN_LIMITS.WALL, max: 10, observed: 10 },
      violations: [],
    });
    assert.deepEqual(verifyChain(log), { ok: true });
  });
});

test("an unattended run refuses to start the agent that would exceed its start limit", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-unattended-starts";
    const deps = makeDeps(dir, { runtime: () => settledRuntime() });

    const result = await runUntilBlocked({
      taskId,
      deps,
      unattended: true,
      limits: { maxWallMinutesPerRun: 60, maxAgentStartsPerRun: 1 },
      sleep: boundedSleep(() => {}),
    });

    assert.equal(result.status, "limit");
    assert.equal(result.rule, RUN_LIMIT_RULE);
    assert.deepEqual(result.limit, { name: RUN_LIMITS.STARTS, max: 1, observed: 1 });

    const events = readEvents(dir, taskId).events;
    assert.equal(
      events.filter((event) => event.type === "stage_started").length,
      1,
      "the run never starts the agent that would breach the limit",
    );
    const enforcement = events.filter((event) => event.type === "enforcement");
    assert.equal(enforcement.length, 1);
    assert.equal(enforcement[0].data.limit.name, RUN_LIMITS.STARTS);
    assert.equal(
      enforcement[0].data.stage,
      "scope",
      "the refused start names the stage it refused",
    );
  });
});

test("the agent-start limit counts this run's starts, not the log's history", async () => {
  await withTempDir(async (dir) => {
    const taskId = "task-unattended-history";
    // A previous run already started two agents; those starts are not this
    // run's starts, so this run may spend its limit again.
    for (const [stage, to] of [
      ["intent", "scope"],
      ["scope", "plan"],
    ]) {
      appendEvent(dir, taskId, {
        type: "stage_started",
        actor: "engine",
        data: { stage, runtime: "fake", handle: `old-${stage}` },
      });
      seedStageDone(dir, taskId, stage, to);
    }

    const deps = makeDeps(dir, { runtime: () => settledRuntime() });
    const result = await runUntilBlocked({
      taskId,
      deps,
      unattended: true,
      limits: { maxWallMinutesPerRun: 60, maxAgentStartsPerRun: 2 },
      sleep: boundedSleep(() => {}),
    });

    assert.equal(result.status, "limit");
    assert.deepEqual(result.limit, { name: RUN_LIMITS.STARTS, max: 2, observed: 2 });
    const started = readEvents(dir, taskId).events.filter(
      (event) => event.type === "stage_started" && event.data.handle.startsWith("handle-"),
    );
    assert.deepEqual(
      started.map((event) => event.data.stage),
      ["plan", "implement"],
      "exactly this run's two starts are spent",
    );
  });
});

test("the step cap bounds an attended run and not an unattended one", async () => {
  await withTempDir(async (dir) => {
    const attendedDir = join(dir, "attended");
    const capped = await runUntilBlocked({
      taskId: "task-cap",
      deps: makeDeps(attendedDir, { runtime: () => settledRuntime() }),
      maxSteps: 2,
    });
    assert.equal(capped.status, "max-steps");
    assert.equal(capped.steps.length, 2);

    const unattended = await runUntilBlocked({
      taskId: "task-cap",
      deps: makeDeps(dir, { runtime: () => settledRuntime() }),
      maxSteps: 1,
      unattended: true,
      limits: { maxWallMinutesPerRun: 60, maxAgentStartsPerRun: 20 },
      sleep: boundedSleep(() => {}),
    });
    assert.equal(unattended.status, "terminal");
    assert.equal(unattended.stage, "done");
    assert.ok(unattended.steps.length > 1, "the step cap does not bound an unattended run");
  });
});

test("a run limit bounds an attended run too, not only an unattended one", async () => {
  await withTempDir(async (dir) => {
    const limits = { maxWallMinutesPerRun: 60, maxAgentStartsPerRun: 1 };
    const deps = makeDeps(dir, { runtime: () => settledRuntime() });
    const stopped = await runUntilBlocked({
      taskId: "task-attended-limit",
      deps,
      maxSteps: 64,
      limits,
    });

    assert.equal(stopped.status, "limit", "an attended run stops on the same limit");
    assert.equal(stopped.rule, RUN_LIMIT_RULE);
    assert.deepEqual(stopped.limit, { name: RUN_LIMITS.STARTS, max: 1, observed: 1 });
    assert.ok(stopped.steps.length < 64, "the limit stopped it, not the step cap");
    const events = readEvents(dir, "task-attended-limit").events;
    assert.equal(
      events.filter((event) => event.type === "enforcement").length,
      1,
      "an attended breach is recorded like an unattended one",
    );

    // The same run without limits drives the task to its terminal stage, so the
    // stop above is the limit and not the lifecycle's own end.
    const unbounded = await runUntilBlocked({
      taskId: "task-attended-nolimit",
      deps,
      maxSteps: 64,
    });
    assert.equal(unbounded.status, "terminal");
  });
});

test("an unattended run refuses to loop without a wall-clock limit", async () => {
  await withTempDir(async (dir) => {
    const deps = makeDeps(dir, { runtime: () => settledRuntime() });
    const cases = [
      { limits: null },
      { limits: { maxAgentStartsPerRun: 5 } },
      { limits: { maxWallMinutesPerRun: null, maxAgentStartsPerRun: 5 } },
      { limits: { maxWallMinutesPerRun: 0, maxAgentStartsPerRun: 5 } },
    ];
    for (const options of cases) {
      await assert.rejects(
        runUntilBlocked({ taskId: "task-unbounded", deps, unattended: true, ...options }),
        /maxWallMinutesPerRun/,
        `expected a refusal for ${JSON.stringify(options.limits)}`,
      );
    }
    await assert.rejects(
      runUntilBlocked({
        taskId: "task-unbounded",
        deps,
        unattended: true,
        limits: { maxWallMinutesPerRun: 60, maxAgentStartsPerRun: 5 },
        sleep: "not a function",
      }),
      /sleep must be a function/,
    );
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
