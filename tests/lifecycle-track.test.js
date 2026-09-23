import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, readEvents } from "../scripts/lifecycle/events.js";
import {
  AUTONOMY_ENGINE_ACTOR,
  R_AUTONOMY_DOWN,
  R_AUTONOMY_UP,
  autonomyChangeEvent,
  autonomyLevel,
  trackRecord,
} from "../scripts/lifecycle/track.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMITTED = JSON.parse(readFileSync(join(ROOT, "yukl.policy.json"), "utf8"));
const TASK = "task-track";

/** A policy with the two thresholds most tests need. */
function policy({
  ceiling = 2,
  levels = [
    { level: 1, minCleanRuns: 5 },
    { level: 2, minCleanRuns: 10 },
  ],
} = {}) {
  return { ceiling, trackRecord: { levels } };
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-track-"));
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

// ---------------------------------------------------------------------------
// trackRecord: control
// ---------------------------------------------------------------------------

test("trackRecord counts a runtime's clean and failed audits and its enforcement stops", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, {
      type: "stage_started",
      actor: "engine",
      data: { stage: "audit", runtime: "rt-a", handle: "h-1" },
    });
    appendEvent(dir, TASK, {
      type: "audit_verdict",
      actor: "dispatch-1",
      data: { verdict: "pass", runtime: "rt-a" },
    });
    appendEvent(dir, TASK, {
      type: "audit_verdict",
      actor: "dispatch-1",
      data: { verdict: "fail", runtime: "rt-b" },
    });
    appendEvent(dir, TASK, {
      type: "stage_started",
      actor: "engine",
      data: { stage: "prove", runtime: "rt-a", handle: "h-2" },
    });
    appendEvent(dir, TASK, {
      type: "enforcement",
      actor: "engine",
      data: { stage: "prove", rule: "R-PATH-SCOPE", violations: ["outside scope"] },
    });
    appendEvent(dir, TASK, {
      type: "audit_verdict",
      actor: "dispatch-2",
      data: { verdict: "pass", runtime: "rt-a" },
    });

    const log = readEvents(dir, TASK);
    assert.deepEqual(trackRecord(log, "rt-a"), {
      runtime: "rt-a",
      cleanAudits: 2,
      failedAudits: 0,
      enforcementStops: 1,
    });
    assert.deepEqual(trackRecord(log, "rt-b"), {
      runtime: "rt-b",
      cleanAudits: 0,
      failedAudits: 1,
      enforcementStops: 0,
    });
    assert.deepEqual(trackRecord(log, "rt-c"), {
      runtime: "rt-c",
      cleanAudits: 0,
      failedAudits: 0,
      enforcementStops: 0,
    });
  });
});

test("an enforcement stop follows the latest stage_started for that stage", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, {
      type: "stage_started",
      actor: "engine",
      data: { stage: "implement", runtime: "rt-a", handle: "h-1" },
    });
    appendEvent(dir, TASK, {
      type: "enforcement",
      actor: "engine",
      data: { stage: "implement", rule: "R-PATH-SCOPE", violations: ["nope"] },
    });
    // A retry hands the same stage to another runtime, which now owns it.
    appendEvent(dir, TASK, {
      type: "stage_started",
      actor: "engine",
      data: { stage: "implement", runtime: "rt-b", handle: "h-2" },
    });
    appendEvent(dir, TASK, {
      type: "enforcement",
      actor: "engine",
      data: { stage: "implement", rule: "R-PATH-SCOPE", violations: ["nope"] },
    });
    // A stage that was never started is attributed to nobody.
    appendEvent(dir, TASK, {
      type: "enforcement",
      actor: "engine",
      data: { stage: "audit", rule: "R-PATH-SCOPE", violations: ["nope"] },
    });

    const log = readEvents(dir, TASK);
    assert.equal(trackRecord(log, "rt-a").enforcementStops, 1);
    assert.equal(trackRecord(log, "rt-b").enforcementStops, 1);
    assert.equal(trackRecord(log, "rt-c").enforcementStops, 0);
  });
});

test("trackRecord tolerates a missing runtime name and malformed events", () => {
  const zero = { runtime: null, cleanAudits: 0, failedAudits: 0, enforcementStops: 0 };
  for (const badName of [undefined, null, "", "   ", 7]) {
    assert.deepEqual(trackRecord([], badName), zero);
  }

  const noise = [null, "not an event", 42, { type: "audit_verdict", data: "not an object" }];
  assert.deepEqual(trackRecord(noise, "rt-a"), trackRecord([], "rt-a"));
});

// ---------------------------------------------------------------------------
// trackRecord: must reject an agent-authored level claim
// ---------------------------------------------------------------------------

test("trackRecord ignores every autonomy_change, so an agent claim never counts", () => {
  const events = [
    {
      type: "stage_started",
      actor: "engine",
      data: { stage: "audit", runtime: "rt-a", handle: "h-1" },
    },
    {
      type: "audit_verdict",
      actor: "dispatch-1",
      data: { verdict: "pass", runtime: "rt-a" },
    },
    {
      type: "autonomy_change",
      actor: "agent-x",
      decision: { kind: "deterministic", rule: R_AUTONOMY_UP },
      data: { runtime: "rt-a", from: 0, to: 9 },
    },
    {
      type: "autonomy_change",
      actor: AUTONOMY_ENGINE_ACTOR,
      decision: { kind: "deterministic", rule: R_AUTONOMY_UP },
      data: { runtime: "rt-a", from: 0, to: 1 },
    },
  ];
  const expected = { runtime: "rt-a", cleanAudits: 1, failedAudits: 0, enforcementStops: 0 };

  assert.deepEqual(trackRecord(events, "rt-a"), expected);
  assert.deepEqual(trackRecord({ events, lines: [], partialTail: null }, "rt-a"), expected);

  // The agent's claim of level 9 earns nothing: only reached thresholds count.
  assert.equal(autonomyLevel(trackRecord(events, "rt-a"), policy()), 0);
});

test("trackRecord and autonomyLevel do not mutate their inputs", () => {
  const events = [
    {
      type: "stage_started",
      actor: "engine",
      data: { stage: "audit", runtime: "rt-a", handle: "h-1" },
    },
    { type: "audit_verdict", actor: "dispatch-1", data: { verdict: "pass", runtime: "rt-a" } },
  ];
  const eventsSnapshot = structuredClone(events);
  const record = trackRecord(events, "rt-a");
  assert.deepEqual(events, eventsSnapshot);

  const recordSnapshot = structuredClone(record);
  const thePolicy = policy();
  const policySnapshot = structuredClone(thePolicy);
  autonomyLevel(record, thePolicy);
  assert.deepEqual(record, recordSnapshot);
  assert.deepEqual(thePolicy, policySnapshot);
});

// ---------------------------------------------------------------------------
// autonomyLevel: control
// ---------------------------------------------------------------------------

test("autonomyLevel raises to each reached threshold and clamps to the ceiling", () => {
  const levels = policy({ ceiling: 2 });
  const at = (cleanAudits) => autonomyLevel({ cleanAudits, enforcementStops: 0 }, levels);

  assert.equal(at(0), 0);
  assert.equal(at(4), 0);
  assert.equal(at(5), 1);
  assert.equal(at(9), 1);
  assert.equal(at(10), 2);
  assert.equal(at(1000), 2, "a record beyond the top threshold still stops at the ceiling");
});

test("autonomyLevel returns a valid level against the committed policy (known-good control)", () => {
  const below = autonomyLevel({ cleanAudits: 4, enforcementStops: 0 }, COMMITTED);
  const at = autonomyLevel({ cleanAudits: 5, enforcementStops: 0 }, COMMITTED);
  const above = autonomyLevel({ cleanAudits: 100, enforcementStops: 0 }, COMMITTED);
  assert.equal(below, 0);
  assert.equal(at, 1);
  assert.equal(above, COMMITTED.ceiling);
});

test("the level decreases by one after an enforcement stop and never below zero", () => {
  const thePolicy = policy({ ceiling: 2 });
  const level = (cleanAudits, enforcementStops) =>
    autonomyLevel({ cleanAudits, enforcementStops }, thePolicy);

  assert.equal(level(10, 0), 2, "a clean record earns the top threshold");
  assert.equal(level(10, 1), 1, "one stop drops exactly one level");
  assert.equal(level(10, 3), 1, "a run of stops still drops only one level");
  assert.equal(level(5, 1), 0);
  assert.equal(level(0, 1), 0, "the level never falls below zero");
});

// ---------------------------------------------------------------------------
// autonomyLevel: must reject a level above the ceiling and a claimed level
// ---------------------------------------------------------------------------

test("a record that would reach ceiling + 1 returns the ceiling", () => {
  const capped = policy({ ceiling: 1 });
  assert.equal(autonomyLevel({ cleanAudits: 10, enforcementStops: 0 }, capped), 1);

  const zeroCeiling = policy({ ceiling: 0, levels: [{ level: 3, minCleanRuns: 1 }] });
  assert.equal(autonomyLevel({ cleanAudits: 10, enforcementStops: 0 }, zeroCeiling), 0);
});

test("autonomyLevel ignores a level name stored on the record", () => {
  const claimed = {
    cleanAudits: 0,
    failedAudits: 0,
    enforcementStops: 0,
    level: 9,
    claimedLevel: 9,
  };
  assert.equal(autonomyLevel(claimed, policy()), 0);
});

// ---------------------------------------------------------------------------
// autonomyChangeEvent: control
// ---------------------------------------------------------------------------

test("autonomyChangeEvent builds the engine's deterministic change event", () => {
  assert.deepEqual(autonomyChangeEvent({ runtime: "rt-a", from: 0, to: 1 }), {
    type: "autonomy_change",
    actor: "engine",
    decision: { kind: "deterministic", rule: R_AUTONOMY_UP },
    data: { runtime: "rt-a", from: 0, to: 1 },
  });

  assert.deepEqual(autonomyChangeEvent({ runtime: "rt-a", from: 3, to: 2 }), {
    type: "autonomy_change",
    actor: "engine",
    decision: { kind: "deterministic", rule: R_AUTONOMY_DOWN },
    data: { runtime: "rt-a", from: 3, to: 2 },
  });
});

// ---------------------------------------------------------------------------
// autonomyChangeEvent: must reject a malformed input
// ---------------------------------------------------------------------------

test("autonomyChangeEvent refuses a malformed input", () => {
  const bad = [
    {},
    undefined,
    { runtime: "rt-a", from: 0 },
    { runtime: "rt-a", to: 1 },
    { runtime: "", from: 0, to: 1 },
    { runtime: "   ", from: 0, to: 1 },
    { runtime: 7, from: 0, to: 1 },
    { runtime: "rt-a", from: -1, to: 1 },
    { runtime: "rt-a", from: 0, to: 1.5 },
    { runtime: "rt-a", from: "0", to: 1 },
    { runtime: "rt-a", from: 1, to: 1 },
  ];
  for (const input of bad) {
    const result = autonomyChangeEvent(input);
    assert.equal(result.ok, false, `${JSON.stringify(input)} must be refused`);
    assert.equal(typeof result.error, "string");
  }
});
