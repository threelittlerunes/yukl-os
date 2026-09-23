// Hermetic acceptance tests for the yukl-os lifecycle (v2-w3-acceptance-a).
//
// Every test drives the real lifecycle modules - engine, events, stages,
// anchors, enforce and the local git VCS adapter - against a throwaway git
// repository that carries a committed intent and config. Only the agent is
// faked, so the pipeline is exercised end to end without a network or a real
// agent process. Each acceptance case has a good twin that passes and a
// known-bad twin that the same check must refuse.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeRuntime } from "../scripts/adapters/fake.js";
import { createVcs } from "../scripts/adapters/vcs-git-local.js";
import { anchorAt, isAncestor } from "../scripts/lifecycle/anchors.js";
import { pathEnforcement } from "../scripts/lifecycle/enforce.js";
import {
  appendEvent,
  headHash,
  readEvents,
  verifyAgainstHead,
  verifyChain,
} from "../scripts/lifecycle/events.js";
import { runUntilBlocked, step } from "../scripts/lifecycle/engine.js";
import * as stages from "../scripts/lifecycle/stages.js";

const TASK_ID = "task-acceptance";
const BASE = "main";
const BRANCH = "task-branch";
const GREEN = 'node -e "process.exit(0)"';
const AGENT_STAGES = ["intent", "scope", "plan", "implement", "prove", "audit", "review"];

// ---------------------------------------------------------------------------
// temp directories
// ---------------------------------------------------------------------------

const TEMP_DIRS = [];

after(async () => {
  for (const dir of TEMP_DIRS) await removeDir(dir);
});

/** A temp root that survives the whole file and is removed by the after hook. */
function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

/** Remove a directory, retrying while Windows still holds a handle briefly. */
async function removeDir(dir) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err.code !== "EPERM" && err.code !== "EBUSY") throw err;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
}

/** Run git and assert it succeeded, returning stdout. */
function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  return result.stdout ?? "";
}

// ---------------------------------------------------------------------------
// the hermetic repository
// ---------------------------------------------------------------------------

function writeIntent(work, { allowedPaths, forbiddenPaths = [] }) {
  const lines = [
    "intent:",
    '  goal: "A hermetic acceptance task."',
    "  scope:",
    "    allowed_paths:",
    ...allowedPaths.map((p) => `      - "${p}"`),
  ];
  if (forbiddenPaths.length > 0) {
    lines.push("    forbidden_paths:");
    for (const p of forbiddenPaths) lines.push(`      - "${p}"`);
  }
  lines.push("consultation:", "  requires_human_approval: false", "");
  mkdirSync(join(work, ".orchestration", "intents"), { recursive: true });
  writeFileSync(join(work, ".orchestration", "intents", `${TASK_ID}.yml`), lines.join("\n"));
}

function writeConfig(work) {
  const config = {
    version: 1,
    commands: { build: null, test: null, format: null },
    folders: {
      contracts: ".orchestration/contracts",
      intents: ".orchestration/intents",
      locks: ".orchestration/locks",
      artifacts: ".orchestration/artifacts",
    },
    allowlist: [GREEN],
  };
  writeFileSync(join(work, "yukl.config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Build a repository with a bare `origin`, the intent and config committed on
 * `main`, and the task branch checked out so `main` is never checked out and
 * the base can move by an ordinary merge. Returns the paths the deps need.
 */
async function buildRepo(
  root,
  { allowedPaths = ["artefacts/**", "src/**"], forbiddenPaths = ["src/secret/**"] } = {},
) {
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  git(["-c", "init.defaultBranch=main", "init", "-q", "--bare", remote], root);
  git(["-c", "init.defaultBranch=main", "init", "-q", work], root);
  git(["config", "user.name", "Yukl Acceptance"], work);
  git(["config", "user.email", "yukl-acceptance@example.invalid"], work);
  git(["remote", "add", "origin", remote.replace(/\\/g, "/")], work);

  writeIntent(work, { allowedPaths, forbiddenPaths });
  writeConfig(work);
  writeFileSync(join(work, "README.md"), "acceptance base\n");
  git(["add", "-A"], work);
  git(["commit", "-q", "-m", "base: merge the intent and config"], work);
  git(["push", "-q", "-u", "origin", BASE], work);

  git(["checkout", "-q", "-b", BRANCH, BASE], work);
  const dir = join(root, "logs");
  mkdirSync(dir, { recursive: true });
  return { root, remote, work, dir };
}

// ---------------------------------------------------------------------------
// the faked agent and the real deps wiring
// ---------------------------------------------------------------------------

/** One scripted step per agent stage: commit an in-scope artefact and exit 0. */
function baseScript(overrides = {}) {
  return AGENT_STAGES.map((stage) => {
    const files = { [`artefacts/${stage}.txt`]: `${stage}\n` };
    Object.assign(files, overrides[stage]?.files ?? {});
    return { files, commit: `${stage} artefact`, exitCode: 0 };
  });
}

/**
 * A script for the restart bad twin: implement fails on its first attempt, so
 * the restart sees no completion and starts implement again. The two attempts
 * write different bytes so each commit has something to record.
 */
function restartScript() {
  const steps = baseScript();
  const implement = steps[3];
  return [
    ...steps.slice(0, 3),
    { ...implement, files: { "artefacts/implement.txt": "attempt one\n" }, exitCode: 1 },
    { ...implement, files: { "artefacts/implement.txt": "attempt two\n" }, exitCode: 0 },
    ...steps.slice(4),
  ];
}

/** Adapt the fake runtime to the engine's opaque-handle interface. */
function fakeRuntime(fake) {
  return {
    name: "fake-agent",
    start: (args) => fake.start(args),
    status: (id) => fake.status({ id }),
    result: (id) => fake.result({ id }),
    stop: (id) => fake.stop({ id }),
  };
}

/** Resolve each stage's committed artefact on the task branch. */
function anchorFor(work) {
  return {
    anchorStage: (stage) => {
      const resolved = anchorAt(work, BRANCH, `artefacts/${stage}.txt`);
      if (!resolved.ok) return { ok: false };
      return { ok: true, anchor: { path: resolved.path, commit: resolved.commit } };
    },
  };
}

/** The full deps object the engine expects, with the real modules. */
function makeDeps({ dir, work, fake, vcs, actors = {} }) {
  return {
    events: { dir, readEvents, appendEvent, headHash },
    stages,
    anchors: anchorFor(work),
    requiresHuman: () => false,
    runtime: () => fakeRuntime(fake),
    enforce: ({ taskId }) => pathEnforcement({ cwd: work, base: BASE, branch: BRANCH, taskId }),
    decide: () => ({ kind: "escalate" }),
    vcs,
    dispatch: (stage) => ({
      actor: actors[stage] ?? `agent-${stage}`,
      env: { YUKL_DISPATCH_ID: `dispatch-${stage}` },
      worktree: work,
      spec: `${TASK_ID}-${stage}`,
      ref: BRANCH,
      base: BASE,
    }),
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
  };
}

/** Step the engine until `stopAfter` matches or the stage can no longer move. */
async function stepUntil({ taskId, deps, stopAfter, maxSteps = 32 }) {
  const outcomes = [];
  for (let i = 0; i < maxSteps; i++) {
    const outcome = await step({ taskId, deps });
    outcomes.push(outcome);
    if (stopAfter(outcome)) break;
    if (outcome.status !== "started" && outcome.status !== "advanced") break;
  }
  return outcomes;
}

/** Normalise a stored event to a plain object for structural comparison. */
function plain(event) {
  return JSON.parse(JSON.stringify(event));
}

// ---------------------------------------------------------------------------
// AC1: the merged lifecycle anchors to the base and commits the run head
// ---------------------------------------------------------------------------

let happyPromise = null;

/**
 * Run the full lifecycle once and share the result across the AC1 tests: the
 * good twin needs the merged repository, the bad twin needs the same log. The
 * temp root is kept alive by the file-level after hook.
 */
function happyRun() {
  if (happyPromise === null) {
    happyPromise = (async () => {
      const root = makeTempDir("yukl-accept-happy-");
      const ctx = await buildRepo(root);
      const fake = createFakeRuntime({ script: baseScript() });
      const vcs = createVcs({ repoDir: ctx.work, base: BASE });
      const deps = makeDeps({ ...ctx, fake, vcs });
      const run = await runUntilBlocked({ taskId: TASK_ID, deps, maxSteps: 32 });
      const log = readEvents(ctx.dir, TASK_ID);
      const message = git(["log", "-1", "--format=%B", BASE], ctx.work);
      const trailer = message.match(/Yukl-Run-Head: (\S+) ([0-9a-f]{64})/);
      return { ...ctx, fake, run, log, message, trailerHash: trailer?.[2] ?? null };
    })();
  }
  return happyPromise;
}

test("AC1: the merged lifecycle anchors every event to the base and commits the run head", async () => {
  const { work, run, log, message, trailerHash } = await happyRun();

  assert.equal(run.status, "terminal", "the good twin must reach a terminal stage");
  assert.equal(run.stage, "done");

  // The intent was merged first, then the task branch was merged into the base.
  const intentOnBase = git(["show", `${BASE}:.orchestration/intents/${TASK_ID}.yml`], work);
  assert.match(intentOnBase, /goal:/);
  assert.equal(isAncestor(work, BRANCH, BASE), true, "the task branch is an ancestor of the base");
  const mergeParents = git(["rev-list", "--parents", "-n", "1", BASE], work).trim().split(/\s+/);
  assert.equal(mergeParents.length, 3, "the base head is a two-parent merge commit");

  // Every anchored event points at a commit reachable from the base.
  const anchored = log.events.filter((event) => event.anchor != null);
  assert.equal(
    anchored.length,
    AGENT_STAGES.length + 1,
    "seven stages plus integrate are anchored",
  );
  for (const event of anchored) {
    assert.match(event.anchor.commit, /^[0-9a-f]{40}$/, "every anchor is a full commit id");
    assert.equal(
      isAncestor(work, event.anchor.commit, BASE),
      true,
      `anchor ${event.anchor.commit} must be reachable from ${BASE}`,
    );
  }

  // The integrity of the log holds and the merge commit carries its head.
  assert.equal(verifyChain(log).ok, true);
  assert.ok(trailerHash, "the merge commit carries the run-head trailer");
  assert.equal(message.includes(`Yukl-Run-Head: ${TASK_ID} ${trailerHash}`), true);
  const verified = verifyAgainstHead(log, trailerHash);
  assert.equal(verified.ok, true, verified.error);
});

test("AC1 must-reject: a tampered run-head hash fails verifyAgainstHead", async () => {
  const { log, trailerHash } = await happyRun();
  const tampered = `${trailerHash[0] === "0" ? "1" : "0"}${trailerHash.slice(1)}`;

  const result = verifyAgainstHead(log, tampered);
  assert.equal(result.ok, false, "a tampered head must not match any committed line");
  assert.match(result.error, /no line in the log hashes to the committed head/);
});

// ---------------------------------------------------------------------------
// AC2: a crash after implement resumes without restarting the agent
// ---------------------------------------------------------------------------

test("AC2: a restart after implement polls the recorded handle and keeps the log intact", async () => {
  const root = makeTempDir("yukl-accept-restart-");
  const ctx = await buildRepo(root);
  const fake = createFakeRuntime({ script: baseScript() });
  const vcs = createVcs({ repoDir: ctx.work, base: BASE });

  // Drive the engine by hand until implement has just advanced, then abandon
  // this deps object: the crash is the discarded engine call.
  const first = makeDeps({ ...ctx, fake, vcs });
  await stepUntil({
    taskId: TASK_ID,
    deps: first,
    stopAfter: (outcome) => outcome.status === "advanced" && outcome.from === "implement",
  });
  assert.equal(
    fake.starts.filter((handle) => handle.stage === "implement").length,
    1,
    "implement was started once before the crash",
  );

  const before = readEvents(ctx.dir, TASK_ID);
  assert.equal(verifyChain(before).ok, true);
  const snapshot = before.events.map(plain);

  // Restart: a fresh deps object against the same log directory and fake.
  const second = makeDeps({ ...ctx, fake, vcs });
  const run = await runUntilBlocked({ taskId: TASK_ID, deps: second, maxSteps: 32 });
  assert.equal(run.status, "terminal");
  assert.equal(run.stage, "done");

  assert.equal(
    fake.starts.filter((handle) => handle.stage === "implement").length,
    1,
    "implement is never started a second time",
  );
  assert.equal(fake.starts.length, AGENT_STAGES.length, "each agent stage is started once");

  const after = readEvents(ctx.dir, TASK_ID);
  assert.deepEqual(
    after.events.slice(0, snapshot.length).map(plain),
    snapshot,
    "the events recorded before the crash are unchanged",
  );
  assert.equal(verifyChain(after).ok, true, "the restarted log still chains");
  assert.equal(
    after.events.filter((event) => event.type === "decision").length,
    before.events.filter((event) => event.type === "decision").length,
    "the restart adds no decision and loses none",
  );
});

test("AC2 must-reject: a tampered log line breaks the chain", async () => {
  const dir = join(makeTempDir("yukl-accept-chain-"), "logs");
  mkdirSync(dir, { recursive: true });
  appendEvent(dir, TASK_ID, {
    type: "stage_started",
    actor: "engine",
    data: { stage: "implement" },
  });
  appendEvent(dir, TASK_ID, {
    type: "decision",
    actor: "engine",
    decision: { kind: "retry" },
    data: { stage: "implement", attempt: 1 },
  });
  appendEvent(dir, TASK_ID, {
    type: "stage_done",
    actor: "agent-shared",
    anchor: { path: "artefacts/implement.txt", commit: "a".repeat(40) },
    data: { stage: "implement", to: "prove" },
  });

  const good = readEvents(dir, TASK_ID);
  assert.equal(verifyChain(good).ok, true, "the untouched log verifies");

  const lines = [...good.lines];
  lines[1] = lines[1].replace('"retry"', '"retry-tampered"');
  writeFileSync(join(dir, `${TASK_ID}.jsonl`), `${lines.join("\n")}\n`);

  const tampered = readEvents(dir, TASK_ID);
  const result = verifyChain(tampered);
  assert.equal(result.ok, false, "a tampered decision must break the chain");
  assert.equal(result.line, 2, "the edited line is named through its successor");
});

test("AC2 must-reject: a restart that starts implement again is caught", async () => {
  const root = makeTempDir("yukl-accept-restart-bad-");
  const ctx = await buildRepo(root);
  const fake = createFakeRuntime({ script: restartScript() });
  const vcs = createVcs({ repoDir: ctx.work, base: BASE });

  // First attempt: implement fails, so its stage_failed closes the handle and
  // the log records no completion for it.
  const first = makeDeps({ ...ctx, fake, vcs });
  const stopped = await runUntilBlocked({ taskId: TASK_ID, deps: first, maxSteps: 32 });
  assert.equal(stopped.status, "escalated");
  assert.equal(stopped.stage, "implement");

  // The restart replays to implement with no open handle, so it starts a
  // second agent for the same stage.
  const restarted = await step({ taskId: TASK_ID, deps: makeDeps({ ...ctx, fake, vcs }) });
  assert.equal(restarted.status, "started");
  assert.equal(restarted.stage, "implement");

  const implementStarts = fake.starts.filter((handle) => handle.stage === "implement");
  assert.equal(implementStarts.length, 2, "the restart started implement a second time");
  assert.notEqual(implementStarts.length, 1, "the start count is not 1 on this input");
  assert.throws(
    () => assert.equal(implementStarts.length, 1, "implement is never started a second time"),
    /implement is never started a second time/,
    "the check the AC2 control relies on must fail on this input",
  );
});

// ---------------------------------------------------------------------------
// AC4: path enforcement and self-approval
// ---------------------------------------------------------------------------

test("AC4 control: an in-path write is not stopped", async () => {
  const root = makeTempDir("yukl-accept-inpath-");
  const ctx = await buildRepo(root);
  const fake = createFakeRuntime({ script: baseScript() });
  const vcs = createVcs({ repoDir: ctx.work, base: BASE });
  const deps = makeDeps({ ...ctx, fake, vcs });

  const outcomes = await stepUntil({
    taskId: TASK_ID,
    deps,
    stopAfter: (outcome) => outcome.status === "advanced" && outcome.from === "implement",
  });
  assert.ok(
    outcomes.some(
      (outcome) =>
        outcome.status === "advanced" && outcome.from === "implement" && outcome.to === "prove",
    ),
    "an in-scope implement advances to prove",
  );

  const log = readEvents(ctx.dir, TASK_ID);
  assert.equal(
    log.events.filter((event) => event.type === "enforcement").length,
    0,
    "an in-scope write is never refused",
  );
  assert.ok(
    log.events.some((event) => event.type === "stage_done" && event.data.to === "prove"),
    "the in-scope implement is recorded as done",
  );
});

test("AC4 must-reject: an out-of-path write is stopped before prove", async () => {
  const root = makeTempDir("yukl-accept-outpath-");
  const ctx = await buildRepo(root);
  const fake = createFakeRuntime({
    script: baseScript({ implement: { files: { "outside/evil.js": "boom\n" } } }),
  });
  const vcs = createVcs({ repoDir: ctx.work, base: BASE });
  const deps = makeDeps({ ...ctx, fake, vcs });

  const run = await runUntilBlocked({ taskId: TASK_ID, deps, maxSteps: 32 });
  assert.equal(run.status, "blocked");
  assert.equal(run.rule, "R-PATH-SCOPE");
  assert.equal(run.stage, "implement");

  const log = readEvents(ctx.dir, TASK_ID);
  const enforcement = log.events.filter((event) => event.type === "enforcement");
  assert.equal(enforcement.length, 1, "the refusal is recorded exactly once");
  assert.equal(enforcement[0].data.stage, "implement");
  assert.equal(enforcement[0].data.rule, "R-PATH-SCOPE");
  assert.ok(
    enforcement[0].data.violations.some((v) =>
      /outside\/evil\.js matches no allowed_paths/.test(v),
    ),
    JSON.stringify(enforcement[0].data.violations),
  );
  assert.equal(
    log.events.some((event) => event.type === "stage_done" && event.data.to === "prove"),
    false,
    "a refused implementation never advances to prove",
  );
});

test("AC4 must-reject: a self-approving audit verdict is refused", async () => {
  const root = makeTempDir("yukl-accept-self-");
  const ctx = await buildRepo(root);
  const fake = createFakeRuntime({ script: baseScript() });
  const vcs = createVcs({ repoDir: ctx.work, base: BASE });
  const deps = makeDeps({
    ...ctx,
    fake,
    vcs,
    actors: { implement: "agent-shared", audit: "agent-shared" },
  });

  const run = await runUntilBlocked({ taskId: TASK_ID, deps, maxSteps: 32 });
  assert.equal(run.status, "blocked");
  assert.equal(run.rule, stages.RULES.SELF_APPROVAL);
  assert.equal(run.stage, "audit");

  const log = readEvents(ctx.dir, TASK_ID);
  const implementDone = log.events.find(
    (event) => event.type === "stage_done" && event.data.stage === "implement",
  );
  assert.equal(implementDone.actor, "agent-shared", "the implement actor is on the record");
  assert.equal(
    log.events.some((event) => event.type === "stage_done" && event.data.to === "review"),
    false,
    "the self-approving audit never advances to review",
  );
});
