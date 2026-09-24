// Hermetic acceptance tests for AC3, AC5, AC6 and AC7.
//
// Each case drives the real lifecycle modules (engine, events, stages,
// diagnosis, reopen, policy and the local git VCS adapter) inside a throwaway
// repository with its own bare remote. No agent process runs: the scripted
// runtime writes and commits the artefact the engine then anchors. The policy
// is read from the fixture repository, so the attempt limit under test is the
// one the repository actually ships.
//
// Every acceptance case has a passing control test plus a must-reject test that
// fails on the bad input.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakeRuntime } from "../scripts/adapters/fake.js";
import { createVcs } from "../scripts/adapters/vcs-git-local.js";
import { run as decideRun } from "../scripts/commands/decide.js";
import { anchorAt } from "../scripts/lifecycle/anchors.js";
import {
  RULES as DIAGNOSE_RULES,
  assertDecision,
  diagnose,
} from "../scripts/lifecycle/diagnose.js";
import { appendEvent, headHash, readEvents } from "../scripts/lifecycle/events.js";
import { runUntilBlocked, step } from "../scripts/lifecycle/engine.js";
import { loadPolicy, requiresHuman } from "../scripts/lifecycle/policy.js";
import { reopen, reopenedStageComplete } from "../scripts/lifecycle/reopen.js";
import * as stages from "../scripts/lifecycle/stages.js";

const TASK_ID = "task-acceptance-b";
const TASK_BRANCH = "task";
const PROOF_COMMAND = "git rev-parse --verify HEAD";
const SEED_COMMIT = "a".repeat(40);
const AC7_SEED = 0x5eedc0de;
const ATTEMPT_LIMIT = 3;

// The ordered agent edges, so the fixture policy can mark each one automatic.
const STAGE_ORDER = [...stages.STAGES, "done"];
const EDGES = STAGE_ORDER.slice(0, -1).map((from, i) => [from, STAGE_ORDER[i + 1]]);

// ---------------------------------------------------------------------------
// fixture helpers: a repository, a bare remote and a scripted fake runtime
// ---------------------------------------------------------------------------

/** Run git in `cwd` with an argument array, throwing on a non-zero exit. */
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error) {
    throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  }
  return result;
}

function gitOut(cwd, args) {
  return git(cwd, args).stdout.trim();
}

/** Write `text` to a repo-relative file, creating any parent directories. */
function write(repo, relPath, text) {
  const abs = join(repo, ...relPath.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

/** Stage everything and commit it, returning the new commit id. */
function commit(repo, message) {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", message]);
  return gitOut(repo, ["rev-parse", "HEAD"]);
}

/**
 * Best-effort removal of the fixture root. Windows keeps `.git` object files
 * locked for a moment after git exits, so retry briefly on EPERM/EBUSY.
 */
async function removeFixture(root) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err.code !== "EPERM" && err.code !== "EBUSY") return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
}

/**
 * Build a throwaway repository in the system temp directory with a local bare
 * remote, seed it with the fixture policy, commit the base on `main`, push it
 * to `origin` and hand the paths to `fn`.
 */
async function withRepo(fn) {
  const root = mkdtempSync(join(tmpdir(), "yukl-acceptance-b-"));
  try {
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    const stateDir = join(root, "state");

    mkdirSync(remote, { recursive: true });
    git(remote, ["init", "--bare"]);

    mkdirSync(work, { recursive: true });
    git(work, ["init", "-b", "main"]);
    git(work, ["config", "user.email", "yukl-acceptance-b@example.invalid"]);
    git(work, ["config", "user.name", "Yukl Acceptance B"]);
    git(work, ["config", "commit.gpgsign", "false"]);

    write(work, "yukl.policy.json", `${JSON.stringify(policyDoc(), null, 2)}\n`);
    write(work, `.orchestration/intents/${TASK_ID}.yml`, intentText());
    write(work, "README.md", "# acceptance-b fixture\n");
    commit(work, "fixture base");

    git(work, ["remote", "add", "origin", remote.replace(/\\/g, "/")]);
    git(work, ["push", "-u", "origin", "main"]);

    return await fn({ root, remote, work, stateDir });
  } finally {
    await removeFixture(root);
  }
}

/** The fixture policy: every agent edge is automatic and the attempt limit is 3. */
function policyDoc() {
  const autonomy = {
    "advance-stage-on-gate-pass": "auto",
    "retry-within-limit": "auto",
    "reopen-earlier-stage": "auto",
  };
  for (const [from, to] of EDGES) autonomy[`advance:${from}->${to}`] = "auto";
  return {
    autonomy,
    ceiling: 1,
    limits: { maxAttemptsPerStage: ATTEMPT_LIMIT },
    budgets: { maxWallMinutesPerRun: null, maxAgentStartsPerRun: null },
    trackRecord: { levels: [{ level: 1, minCleanRuns: 5 }] },
  };
}

function intentText() {
  return [
    "intent:",
    '  goal: "acceptance-b fixture"',
    "  scope:",
    "    allowed_paths:",
    '      - "**"',
    "",
  ].join("\n");
}

/** Load the policy from the fixture repository's `main` ref. */
function loadFixturePolicy(work) {
  const loaded = loadPolicy({ cwd: work, base: "main" });
  assert.equal(loaded.ok, true, loaded.errors.join("; "));
  assert.equal(loaded.policy.limits.maxAttemptsPerStage, ATTEMPT_LIMIT);
  return loaded.policy;
}

/** A scripted step that writes the stage's artefact, commits it and succeeds. */
function successStep(stage) {
  return {
    exitCode: 0,
    commit: true,
    files: { [`artifacts/${stage}.md`]: `${stage} complete\n` },
  };
}

/**
 * One fake runtime per stage, replaying that stage's scripted outcomes. The
 * engine records a string handle, so the runtime maps that id back to the
 * handle object the fake holds.
 */
function runtimeFactory(scriptsByStage) {
  const runtimes = new Map();
  return (stage) => {
    if (!runtimes.has(stage)) {
      const script = scriptsByStage[stage] ?? [successStep(stage)];
      const fake = createFakeRuntime({ script });
      const byId = new Map();
      runtimes.set(stage, {
        name: `fake-${stage}`,
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
    }
    return runtimes.get(stage);
  };
}

/**
 * The diagnosis seam: classify the observation and choose the next
 * intervention. The pure diagnosis marks escalation with
 * `intervention: "escalate"`; the engine stops the loop on an
 * `action: "escalate"` decision, so the two vocabularies are joined here.
 */
function decideFor(policy) {
  return (observation, history) => {
    const decision = diagnose(observation, history?.decisions ?? [], policy);
    assertDecision(decision);
    return decision.intervention === "escalate" ? { ...decision, action: "escalate" } : decision;
  };
}

/** A full engine environment over the real modules, with only the agent faked. */
function engineDeps({ stateDir, policy, work, taskBranch, scriptsByStage, withVcs = false }) {
  const runtimeFor = runtimeFactory(scriptsByStage);
  const deps = {
    events: { dir: stateDir, readEvents, appendEvent, headHash },
    stages,
    anchors: {
      anchorStage: async (stage) => {
        const outcome = anchorAt(work, taskBranch, `artifacts/${stage}.md`);
        if (!outcome.ok) return { ok: false };
        return {
          ok: true,
          anchor: { path: outcome.path, commit: outcome.commit, blob: outcome.blob },
        };
      },
    },
    requiresHuman: (id) => requiresHuman(policy, id, 0),
    runtime: (stage) => (stage === "integrate" ? null : runtimeFor(stage)),
    decide: decideFor(policy),
    dispatch: (stage) => ({
      actor: `fake-agent-${stage}`,
      env: { YUKL_DISPATCH_ID: `fake-${stage}` },
      worktree: work,
      spec: `${TASK_ID}:${stage}`,
      ref: taskBranch,
      base: "main",
    }),
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
  };
  if (withVcs) {
    deps.vcs = createVcs({ repoDir: work, base: "main", commands: [PROOF_COMMAND] });
  }
  return deps;
}

/** A side-effect-free environment that only replays the log to a stage. */
function probeDeps({ stateDir, policy }) {
  return {
    events: { dir: stateDir, readEvents, appendEvent, headHash },
    stages,
    anchors: { anchorStage: async () => ({ ok: false }) },
    requiresHuman: (id) => requiresHuman(policy, id, 0),
    runtime: () => null,
  };
}

/** Seed a valid log so that `lastDone` is the current stage. */
function seedThrough(stateDir, lastDone) {
  const order = stages.STAGES;
  const limit = order.indexOf(lastDone);
  for (let i = 0; i < limit; i++) {
    appendEvent(stateDir, TASK_ID, {
      type: "stage_done",
      actor: `seed-${order[i]}`,
      anchor: { path: `${order[i]}.md`, commit: SEED_COMMIT },
      data: { stage: order[i], to: order[i + 1] },
    });
  }
}

/** Check every decision event in a log with the real `assertDecision`. */
function checkDecisionLog(events) {
  const decisions = events.filter((event) => event?.type === "decision");
  for (const event of decisions) assertDecision(event.decision);
  return decisions;
}

/** A small seeded PRNG (mulberry32), so AC7's stage choice is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The (intervention, inputHash) pair a decision would repeat. */
function pairOf(decision) {
  return `${decision.intervention}\u0000${decision.inputHash}`;
}

// ---------------------------------------------------------------------------
// AC3: a failing implementation is diagnosed, never retried the same way
// ---------------------------------------------------------------------------

test("AC3 control: a failing implementation is diagnosed and the second intervention differs", async () => {
  await withRepo(async ({ work, stateDir }) => {
    const policy = loadFixturePolicy(work);
    seedThrough(stateDir, "implement");
    const scriptsByStage = {
      implement: [{ exitCode: 1 }, { exitCode: 1 }, { exitCode: 1 }, { exitCode: 1 }],
    };

    const result = await runUntilBlocked({
      taskId: TASK_ID,
      deps: engineDeps({ stateDir, policy, work, taskBranch: TASK_BRANCH, scriptsByStage }),
      maxSteps: 32,
    });

    assert.equal(result.status, "escalated");
    assert.equal(result.stage, "implement");

    const events = readEvents(stateDir, TASK_ID).events;
    const decisions = events.filter((event) => event.type === "decision").map((e) => e.decision);
    assert.equal(decisions.length, 4, "four attempts are recorded before the limit escalates");
    assert.ok(decisions.every((decision) => decision.category === "implementation_defect"));

    assert.equal(decisions[0].intervention, "retry");
    assert.equal(decisions[1].intervention, "apprising");
    assert.notEqual(
      decisions[1].intervention,
      decisions[0].intervention,
      "the second intervention differs from the first",
    );
    assert.notEqual(decisions[1].inputHash, decisions[0].inputHash);

    const last = decisions.at(-1);
    assert.equal(last.kind, "deterministic");
    assert.equal(
      last.rule,
      DIAGNOSE_RULES.ATTEMPT_LIMIT,
      "the attempt limit forces the escalation",
    );
    assert.equal(last.intervention, "escalate");

    for (const decision of decisions) assertDecision(decision);
  });
});

test("AC3 must-reject: a history that already holds the pairs escalates instead of repeating one", () => {
  const policy = { limits: { maxAttemptsPerStage: ATTEMPT_LIMIT } };
  const decide = decideFor(policy);
  const observation = { stage: "implement", exitCode: 1 };

  const first = decide(observation, { decisions: [] });
  const second = decide(observation, { decisions: [first] });
  const third = decide(observation, { decisions: [first, second] });
  assert.equal(first.intervention, "retry");
  assert.equal(second.intervention, "apprising");
  assert.equal(third.intervention, "collaboration");

  const used = new Set([first, second].map(pairOf));
  const next = decide(observation, { decisions: [first, second] });
  assert.equal(used.has(pairOf(next)), false, "a pair already used is not produced again");

  const saturated = decide(observation, { decisions: [first, second, third] });
  assert.equal(saturated.kind, "deterministic");
  assert.equal(saturated.rule, DIAGNOSE_RULES.ATTEMPT_LIMIT);
  assert.equal(saturated.intervention, "escalate");
});

// ---------------------------------------------------------------------------
// AC5: every decision in a whole run is well-formed
// ---------------------------------------------------------------------------

test("AC5 control: every decision event in a full run carries a rule, or inputs and a rationale", async () => {
  await withRepo(async ({ work, stateDir }) => {
    const policy = loadFixturePolicy(work);
    git(work, ["checkout", "-b", TASK_BRANCH]);
    const scriptsByStage = {
      implement: [{ exitCode: 1 }, { exitCode: 1 }, successStep("implement")],
      prove: [{ exitCode: 1 }, successStep("prove")],
    };

    const result = await runUntilBlocked({
      taskId: TASK_ID,
      deps: engineDeps({
        stateDir,
        policy,
        work,
        taskBranch: TASK_BRANCH,
        scriptsByStage,
        withVcs: true,
      }),
      maxSteps: 64,
    });

    assert.equal(result.status, "terminal");
    assert.equal(result.stage, "done");

    const decisions = checkDecisionLog(readEvents(stateDir, TASK_ID).events);
    assert.ok(decisions.length >= 3, "a run with failures records decisions");

    const implement = decisions.filter((event) => event.data.stage === "implement");
    assert.equal(implement.length, 2);
    assert.notEqual(
      implement[0].decision.intervention,
      implement[1].decision.intervention,
      "the retried implementation is diagnosed differently",
    );
  });
});

test("AC5 must-reject: a decision without inputs or a rationale fails assertDecision", () => {
  assert.throws(
    () =>
      checkDecisionLog([{ type: "decision", decision: { kind: "adaptive", intervention: "x" } }]),
    { message: "an adaptive decision needs inputs" },
  );
  assert.throws(
    () => checkDecisionLog([{ type: "decision", decision: { kind: "adaptive", inputs: {} } }]),
    { message: "an adaptive decision needs a non-empty rationale" },
  );
  assert.throws(
    () => checkDecisionLog([{ type: "decision", decision: { kind: "deterministic" } }]),
    { message: "a deterministic decision needs a non-empty rule" },
  );
  assert.throws(() => checkDecisionLog([{ type: "decision", decision: { kind: "guess" } }]), {
    message: 'decision.kind must be "adaptive" or "deterministic"',
  });
});

// ---------------------------------------------------------------------------
// AC6: an audit finding reopens scope, and only a merged amendment completes it
// ---------------------------------------------------------------------------

test("AC6 control: an audit finding reopens scope and a merged amendment completes it", async () => {
  await withRepo(async ({ work, stateDir }) => {
    const policy = loadFixturePolicy(work);
    write(work, "docs/scope.md", "initial scope\n");
    const initial = commit(work, "add scope");

    seedThrough(stateDir, "audit");
    const finding = {
      target: "scope",
      relPath: "docs/scope.md",
      summary: "the scope omits the failure path",
    };
    const event = reopen({ stage: "audit" }, finding);
    assert.equal(event.type, "reopen");
    appendEvent(stateDir, TASK_ID, event);

    const replayed = await step({ taskId: TASK_ID, deps: probeDeps({ stateDir, policy }) });
    assert.equal(replayed.stage, "scope", "the engine replays the reopen back to scope");

    git(work, ["checkout", "-b", "amendment"]);
    write(work, "docs/scope.md", "amended scope\n");
    const amended = commit(work, "amend scope");

    const unmerged = reopenedStageComplete({
      cwd: work,
      base: "main",
      relPath: "docs/scope.md",
      previousAnchor: { commit: initial },
    });
    assert.equal(unmerged.ok, false, "the reopened stage is not complete before the merge");

    git(work, ["checkout", "main"]);
    git(work, ["merge", "--no-ff", "-m", "merge amendment", "amendment"]);

    const merged = reopenedStageComplete({
      cwd: work,
      base: "main",
      relPath: "docs/scope.md",
      previousAnchor: { commit: initial },
    });
    assert.equal(merged.ok, true, "the reopened stage completes once the amendment is on the base");
    assert.equal(merged.anchor.commit, amended);
    assert.notEqual(merged.anchor.commit, initial);
  });
});

test("AC6 must-reject: an amendment only on an unmerged branch does not complete the reopened stage", async () => {
  await withRepo(async ({ work }) => {
    write(work, "docs/scope.md", "initial scope\n");
    const initial = commit(work, "add scope");
    git(work, ["push", "origin", "main"]);

    git(work, ["checkout", "-b", "amendment"]);
    write(work, "docs/scope.md", "amended scope\n");
    const amended = commit(work, "amend scope on the branch");
    git(work, ["push", "origin", "amendment"]);

    assert.equal(gitOut(work, ["rev-parse", "main"]), initial);
    assert.equal(gitOut(work, ["rev-parse", "amendment"]), amended);

    const remoteHead = gitOut(work, ["ls-remote", "--heads", "origin", "amendment"]);
    assert.match(
      remoteHead,
      new RegExp(`^${amended}\\s+refs/heads/amendment$`),
      "the amendment branch is on the bare remote, not on the base",
    );

    const result = reopenedStageComplete({
      cwd: work,
      base: "main",
      relPath: "docs/scope.md",
      previousAnchor: { commit: initial },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /still anchored|not on main|does not descend/);
  });
});

// ---------------------------------------------------------------------------
// AC7: an override at a seeded pseudo-random stage is honoured and replayed
// ---------------------------------------------------------------------------

test("AC7 control: a seeded pseudo-random override is honoured and recorded", async () => {
  await withRepo(async ({ work, stateDir }) => {
    const policy = loadFixturePolicy(work);
    git(work, ["checkout", "-b", TASK_BRANCH]);
    seedThrough(stateDir, "implement");

    const random = mulberry32(AC7_SEED);
    const target = stages.STAGES[Math.floor(random() * stages.STAGES.length)];
    console.log(`[acceptance-b] AC7 seed ${AC7_SEED} selected override target ${target}`);

    const saved = process.env.YUKL_DISPATCH_ID;
    delete process.env.YUKL_DISPATCH_ID;
    let code;
    try {
      code = decideRun([
        "override",
        "--task",
        TASK_ID,
        "--by",
        "root",
        "--reason",
        "seeded override",
        "--to",
        target,
        "--state-dir",
        stateDir,
      ]);
    } finally {
      if (saved !== undefined) process.env.YUKL_DISPATCH_ID = saved;
    }
    assert.equal(code, 0);

    const override = readEvents(stateDir, TASK_ID).events.at(-1);
    assert.equal(override.type, "human_decision");
    assert.equal(override.actor, "human:root");
    assert.equal(override.data.decision, "override");
    assert.equal(override.data.to, target);

    const replayed = await step({ taskId: TASK_ID, deps: probeDeps({ stateDir, policy }) });
    assert.equal(replayed.stage, target, "the engine's replay reflects the override");
  });
});

test("AC7 must-reject: decide with YUKL_DISPATCH_ID set appends nothing", async () => {
  await withRepo(async ({ work, stateDir }) => {
    loadFixturePolicy(work);
    git(work, ["checkout", "-b", TASK_BRANCH]);
    seedThrough(stateDir, "implement");
    const logPath = join(stateDir, `${TASK_ID}.jsonl`);
    const before = statSync(logPath).size;

    const saved = process.env.YUKL_DISPATCH_ID;
    process.env.YUKL_DISPATCH_ID = "dispatch-agent-1";
    let code;
    try {
      code = decideRun([
        "pause",
        "--task",
        TASK_ID,
        "--by",
        "alice",
        "--reason",
        "hold",
        "--state-dir",
        stateDir,
      ]);
    } finally {
      if (saved === undefined) delete process.env.YUKL_DISPATCH_ID;
      else process.env.YUKL_DISPATCH_ID = saved;
    }
    assert.equal(code, 1);
    assert.equal(statSync(logPath).size, before, "a dispatched agent appends nothing");
  });
});
