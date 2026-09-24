// Lifecycle engine: one step and the run-until-blocked loop (v2-w2).
//
// The engine turns a lifecycle state into the next action and holds none of the
// rules that decide what that action is. Everything it needs is injected
// through `deps`: the event log, the pure stage machine, artefact anchoring, the
// human-authority policy, the per-stage runtime adapters, path enforcement,
// failure diagnosis, the VCS merge and the clock. This module therefore imports
// nothing at all, so it stays free of any single agent's vocabulary and of any
// particular adapter. A caller wires the real modules together; the tests wire
// doubles next to the real log and stage machine.

/** The status of one `step` outcome. */
const STEP = Object.freeze({
  STARTED: "started",
  WAITING: "waiting",
  ADVANCED: "advanced",
  BLOCKED: "blocked",
  ENFORCED: "enforced",
  FAILED: "failed",
  TERMINAL: "terminal",
});

/** The status of a `runUntilBlocked` result. */
const RUN = Object.freeze({
  TERMINAL: "terminal",
  BLOCKED: "blocked",
  ESCALATED: "escalated",
  WAITING: "waiting",
  MAX_STEPS: "max-steps",
  LIMIT: "limit",
});

const DEFAULT_MAX_STEPS = 64;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const ENGINE = "engine";
const FALLBACK_PATH_SCOPE_RULE = "R-PATH-SCOPE";
const FALLBACK_RUNTIME_ID = "runtime";
const INTEGRATE_RUNTIME_ID = "vcs";
const INTEGRATE_HANDLE_PREFIX = "merge:";

/** The rule recorded when a breached run limit stops a run. */
export const RUN_LIMIT_RULE = "R-RUN-LIMIT";

/** The run limit keys a run can breach (see yukl.policy.json `budgets`). */
export const RUN_LIMITS = Object.freeze({
  WALL: "maxWallMinutesPerRun",
  STARTS: "maxAgentStartsPerRun",
});

/** The `human_decision` view of the stage machine only reads top-level fields,
 * but `appendEvent` does not persist them, so replay them from `data`. */
function replayInput(event) {
  if (event.type !== "human_decision") return event;
  const data = event.data ?? {};
  return { type: "human_decision", actor: event.actor, stage: data.to, action: data.action };
}

/**
 * Apply a `reopen` event. A reopen is the accepted way to leave a terminal
 * stage, and the stage machine deliberately closes every other edge out of one,
 * so the move is routed through `stages.transition` when the machine allows it
 * and rewound directly when the machine refuses because the current stage is
 * closed. A target that is not a lifecycle stage is ignored.
 */
function applyReopen(state, event, stages) {
  const to = event.data?.to;
  if (!Array.isArray(stages.STAGES) || !stages.STAGES.includes(to)) return state;
  const outcome = stages.transition(state, { type: "human_decision", stage: to });
  if (outcome.ok) return outcome.next;
  return { ...state, stage: to, paused: false };
}

/**
 * Rebuild the lifecycle state from a task's events.
 *
 * Only the events the stage machine accepts can move the state: `stage_done`,
 * `human_decision` and `reopen` are replayed through `stages.transition` from
 * `stages.initialState()`, and a refusal leaves the state where it was. Every
 * other event type is ignored.
 */
function replay(events, stages) {
  let state = stages.initialState();
  for (const event of events) {
    if (event === null || typeof event !== "object" || typeof event.type !== "string") continue;
    if (event.type === "reopen") {
      state = applyReopen(state, event, stages);
      continue;
    }
    if (event.type !== "stage_done" && event.type !== "human_decision") continue;
    const outcome = stages.transition(state, replayInput(event));
    if (outcome.ok) state = outcome.next;
  }
  return state;
}

/** True when `stage` is one of the stage machine's terminal states. */
function isTerminal(stage, stages) {
  return Array.isArray(stages.TERMINAL) && stages.TERMINAL.includes(stage);
}

/**
 * The open start for `stage`, if any: the handle of a runtime still running and
 * any enforcement already recorded against it. A later `stage_done` or
 * `stage_failed` closes the start, so a retry begins with no handle and no
 * recorded enforcement. An `enforcement` event marks the open handle as already
 * refused, so a later step returns that refusal instead of recording it again.
 */
function openStage(events, stage) {
  const open = { handle: null, enforcement: null };
  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    if (event.data?.stage !== stage) continue;
    if (event.type === "stage_started") {
      open.handle = event.data?.handle ?? null;
      open.enforcement = null;
    } else if (event.type === "enforcement") {
      open.enforcement = { rule: event.data?.rule, violations: event.data?.violations };
    } else if (event.type === "stage_done" || event.type === "stage_failed") {
      open.handle = null;
      open.enforcement = null;
    }
  }
  return open;
}

/** Count the events of `type` whose `data.stage` is `stage`. */
function countForStage(events, type, stage) {
  let count = 0;
  for (const event of events) {
    if (event?.type === type && event?.data?.stage === stage) count += 1;
  }
  return count;
}

/** Normalise whatever a runtime returned from `start` to a non-empty string id. */
function handleId(handle) {
  if (typeof handle === "string" && handle !== "") return handle;
  if (
    handle !== null &&
    typeof handle === "object" &&
    typeof handle.id === "string" &&
    handle.id !== ""
  ) {
    return handle.id;
  }
  throw new Error("runtime.start must return a non-empty string handle id");
}

/** The string id recorded in `stage_started.data.runtime`. */
function runtimeName(deps, stage, runtime) {
  if (typeof deps.runtimeId === "function") {
    const id = deps.runtimeId(stage);
    if (typeof id === "string" && id !== "") return id;
  }
  if (runtime !== null && typeof runtime.name === "string" && runtime.name !== "") {
    return runtime.name;
  }
  return FALLBACK_RUNTIME_ID;
}

/** The adapter for `stage`, or null when the stage is a gate. */
function runtimeFor(deps, stage) {
  const runtime = typeof deps.runtime === "function" ? deps.runtime(stage) : null;
  return runtime === undefined ? null : runtime;
}

/** The per-stage dispatch context, or an empty object when none is injected. */
function dispatchFor(deps, stage, taskId) {
  const dispatch = typeof deps.dispatch === "function" ? deps.dispatch(stage, taskId) : null;
  return dispatch !== null && typeof dispatch === "object" ? dispatch : {};
}

/** The actor recorded on a `stage_done` event. */
function actorFor(deps, stage, taskId, result) {
  const dispatch = dispatchFor(deps, stage, taskId);
  if (typeof dispatch.actor === "string" && dispatch.actor.trim() !== "") return dispatch.actor;
  const dispatchId = result?.env?.YUKL_DISPATCH_ID;
  if (typeof dispatchId === "string" && dispatchId.trim() !== "") return dispatchId;
  return ENGINE;
}

/** The injected human-authority policy, defaulting to "never needs a human". */
function humanPolicy(deps) {
  return (id, context) =>
    typeof deps.requiresHuman === "function" ? Boolean(deps.requiresHuman(id, context)) : false;
}

/** The injected clock, defaulting to the wall clock. */
function now(deps) {
  return typeof deps.clock === "function" ? deps.clock() : new Date();
}

/** Append one event to the task's log through the injected events dependency. */
function append(deps, taskId, event) {
  deps.events.appendEvent(deps.events.dir, taskId, event);
}

/**
 * Ask a runtime about a recorded handle. A settled result is `exited`; anything
 * else that is not `live` is treated as unverifiable, and an exited handle with
 * no result is refused. A zero exit code succeeds, any other code - including a
 * missing one - fails.
 */
async function inspectRuntime(runtime, handle) {
  const status = await runtime.status(handle);
  if (status === "live") return { settled: false };
  if (status !== "exited") {
    return { settled: true, ok: false, observation: { runtimeRefused: true } };
  }
  const result = await runtime.result(handle);
  if (result === null || result === undefined) {
    return { settled: true, ok: false, observation: { runtimeRefused: true } };
  }
  if (result.timedOut === true) {
    return { settled: true, ok: false, observation: { exitCode: null, timedOut: true } };
  }
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
  if (exitCode === 0) return { settled: true, ok: true, result };
  return { settled: true, ok: false, observation: { exitCode } };
}

/** Resolve the completed stage's artefact anchor, or report that it could not. */
async function resolveAnchor(deps, stage, taskId) {
  if (deps.anchors === null || typeof deps.anchors !== "object") return { ok: false };
  if (typeof deps.anchors.anchorStage !== "function") return { ok: false };
  const outcome = await deps.anchors.anchorStage(stage, taskId);
  if (outcome !== null && typeof outcome === "object" && outcome.ok === true && outcome.anchor) {
    return { ok: true, anchor: outcome.anchor };
  }
  return { ok: false };
}

/** The outcome for a stage whose open handle was already refused by enforcement. */
function enforcedOutcome(stage, enforcement) {
  const rule =
    typeof enforcement.rule === "string" && enforcement.rule !== ""
      ? enforcement.rule
      : FALLBACK_PATH_SCOPE_RULE;
  const violations = Array.isArray(enforcement.violations) ? enforcement.violations : [];
  return { status: STEP.ENFORCED, stage, rule, violations };
}

/**
 * Run the injected path enforcement after an agent stage finished. Returns an
 * outcome when enforcement refuses (after recording an `enforcement` event), or
 * null when it passes or no enforcement is injected.
 */
async function enforceStage({ taskId, deps, state, stage }) {
  if (typeof deps.enforce !== "function") return null;
  const outcome = await deps.enforce({ stage, taskId, state });
  if (outcome === null || typeof outcome !== "object" || outcome.ok !== false) return null;
  const rule =
    typeof outcome.rule === "string" && outcome.rule !== ""
      ? outcome.rule
      : FALLBACK_PATH_SCOPE_RULE;
  const violations = Array.isArray(outcome.violations) ? outcome.violations : [];
  append(deps, taskId, { type: "enforcement", actor: ENGINE, data: { stage, rule, violations } });
  return enforcedOutcome(stage, { rule, violations });
}

/**
 * Build the `stage_done` event for a completed stage and append it only when the
 * stage machine accepts the move. A refusal appends nothing that advances: it is
 * returned as a block naming the rule, so R-NEEDS-HUMAN stops the loop.
 */
async function completeStage({ taskId, deps, state, stage, anchor, actor }) {
  const event = { type: "stage_done", actor, anchor, data: { stage } };
  const outcome = deps.stages.transition(state, event, { requiresHuman: humanPolicy(deps) });
  if (!outcome.ok) {
    return { status: STEP.BLOCKED, stage, rule: outcome.rule };
  }
  event.data.to = outcome.next.stage;
  append(deps, taskId, event);
  return { status: STEP.ADVANCED, from: stage, to: outcome.next.stage, rule: outcome.rule };
}

/** Finish an agent stage that reported success through its runtime. */
async function completeAgentStage({ taskId, deps, state, stage, runtime, result }) {
  const refusal = await enforceStage({ taskId, deps, state, stage });
  if (refusal !== null) return refusal;
  const anchored = await resolveAnchor(deps, stage, taskId);
  if (!anchored.ok) {
    return { status: STEP.BLOCKED, stage, rule: deps.stages.RULES.NO_ANCHOR };
  }
  const actor = actorFor(deps, stage, taskId, result);
  return completeStage({ taskId, deps, state, stage, anchor: anchored.anchor, actor });
}

/** Start an agent stage's runtime and record the handle before doing anything
 * else, so a crash after the start is recoverable by polling that handle. */
async function startStage({ taskId, deps, stage, runtime }) {
  const dispatch = dispatchFor(deps, stage, taskId);
  const handle = await runtime.start({
    stage,
    taskId,
    spec: dispatch.spec,
    worktree: dispatch.worktree,
    env: dispatch.env,
  });
  const id = handleId(handle);
  append(deps, taskId, {
    type: "stage_started",
    actor: ENGINE,
    data: { stage, runtime: runtimeName(deps, stage, runtime), handle: id },
  });
  return { status: STEP.STARTED, stage, handle: id };
}

/** Poll a gate stage's check; it completes only when the injected gate passes. */
async function gateStage({ taskId, deps, state, log, stage }) {
  if (typeof deps.gate !== "function") return { status: STEP.WAITING, stage, gate: true };
  const check = await deps.gate(stage, { taskId, state, log });
  if (check === null || typeof check !== "object" || check.ok !== true) {
    return { status: STEP.WAITING, stage, gate: true };
  }
  const actor = actorFor(deps, stage, taskId, null);
  return completeStage({ taskId, deps, state, stage, anchor: check.anchor, actor });
}

/** Record a failed stage and ask the injected diagnosis for the next move. */
async function failStage({ taskId, deps, state, log, stage, runtimeId, observation }) {
  append(deps, taskId, {
    type: "stage_failed",
    actor: ENGINE,
    data: { stage, runtime: runtimeId, observation },
  });
  const attempt = countForStage(log.events, "stage_failed", stage) + 1;
  const decisions = log.events
    .filter((event) => event?.type === "decision" && event?.data?.stage === stage)
    .map((event) => event.decision);
  const history = { stage, state, attempts: attempt - 1, decisions, at: now(deps) };
  const produced =
    typeof deps.decide === "function" ? await deps.decide(observation, history) : null;
  const decision =
    produced !== null && typeof produced === "object" ? produced : { kind: "escalate" };
  append(deps, taskId, { type: "decision", actor: ENGINE, decision, data: { stage, attempt } });
  return { status: STEP.FAILED, stage, attempt, observation, decision };
}

/** True when the VCS confirms the integrate merge already happened. */
function isMergeConfirmed(merged) {
  if (merged === true) return true;
  if (merged === null || typeof merged !== "object") return false;
  return merged.ok === true || merged.merged === true;
}

/** The anchor for an integrate merge confirmed by the VCS, or null when none. */
function mergeAnchor(dispatch, merged) {
  if (dispatch.anchor) return dispatch.anchor;
  const sha = merged !== null && typeof merged === "object" ? merged.sha : null;
  if (typeof sha === "string" && sha !== "") return { path: dispatch.base ?? "", commit: sha };
  return null;
}

/** Call the injected merge once and finish the stage, or diagnose a failure. */
async function mergeIntegrate({ taskId, deps, state, stage, dispatch }) {
  const current = deps.events.readEvents(deps.events.dir, taskId);
  const hash = deps.events.headHash(current);
  const merge = await deps.vcs.merge(dispatch.ref, dispatch.base, {
    runHead: { taskId, hash },
  });
  if (merge === null || typeof merge !== "object" || merge.ok !== true) {
    const detail =
      typeof merge?.error === "string" && merge.error !== "" ? merge.error : "vcs merge failed";
    return failStage({
      taskId,
      deps,
      state,
      log: current,
      stage,
      runtimeId: INTEGRATE_RUNTIME_ID,
      observation: { stage, runtimeRefused: true, detail },
    });
  }
  const anchor = dispatch.anchor ?? { path: dispatch.base ?? "", commit: merge.sha };
  const actor = actorFor(deps, stage, taskId, null);
  return completeStage({ taskId, deps, state, stage, anchor, actor });
}

/**
 * Merge the task branch into the base with the log head as the run head. A
 * `stage_started` marker is recorded before the merge, so a crash between the
 * merge and the `stage_done` is visible on resume: the engine then asks the VCS
 * whether the merge already happened and only merges again when it did not, or
 * blocks for a human when the VCS cannot say.
 */
async function integrateStage({ taskId, deps, state, log }) {
  const stage = "integrate";
  if (deps.vcs === null || typeof deps.vcs !== "object" || typeof deps.vcs.merge !== "function") {
    return { status: STEP.BLOCKED, stage, rule: "R-NO-VCS" };
  }
  const dispatch = dispatchFor(deps, stage, taskId);
  const open = openStage(log.events, stage);

  if (open.handle !== null) {
    if (typeof deps.vcs.merged !== "function") {
      return { status: STEP.BLOCKED, stage, rule: deps.stages.RULES.NEEDS_HUMAN };
    }
    const merged = await deps.vcs.merged(dispatch.ref, dispatch.base);
    if (!isMergeConfirmed(merged)) {
      return mergeIntegrate({ taskId, deps, state, stage, dispatch });
    }
    const anchor = mergeAnchor(dispatch, merged);
    if (anchor === null) {
      return { status: STEP.BLOCKED, stage, rule: deps.stages.RULES.NEEDS_HUMAN };
    }
    const actor = actorFor(deps, stage, taskId, null);
    return completeStage({ taskId, deps, state, stage, anchor, actor });
  }

  append(deps, taskId, {
    type: "stage_started",
    actor: ENGINE,
    data: {
      stage,
      runtime: INTEGRATE_RUNTIME_ID,
      handle: `${INTEGRATE_HANDLE_PREFIX}${taskId}`,
    },
  });
  return mergeIntegrate({ taskId, deps, state, stage, dispatch });
}

/**
 * True when a diagnosis chose to escalate rather than to try again. The
 * diagnosis module marks escalation with `intervention: "escalate"`, carried by
 * each of its deterministic escalation rules (`R-ATTEMPT-LIMIT`,
 * `R-UNCLASSIFIED`, `R-TABLE-EXHAUSTED`), so that is the shape the engine must
 * read. `kind` or `action` of "escalate" and `escalate: true` are the earlier
 * spellings and keep working, so no caller has to translate a diagnosis into an
 * engine-specific vocabulary before the loop can stop on it.
 */
function isEscalation(decision) {
  if (decision === null || typeof decision !== "object") return false;
  return (
    decision.kind === "escalate" ||
    decision.action === "escalate" ||
    decision.intervention === "escalate" ||
    decision.escalate === true
  );
}

/** True when `value` is a positive integer. */
function positiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

/** The seq the next event of a run will carry, i.e. one past the log's last. */
function nextSeq(deps, taskId) {
  const log = deps.events.readEvents(deps.events.dir, taskId);
  const last = log.events.at(-1);
  return last === undefined || !Number.isInteger(last.seq) ? 0 : last.seq + 1;
}

/**
 * How many agents a run has started: every `stage_started` event appended at or
 * after `startSeq` that dispatches an agent. The `integrate` stage records a
 * `stage_started` marker of its own for the VCS merge, which is not an agent.
 */
function runAgentStarts(events, startSeq) {
  let count = 0;
  for (const event of events) {
    if (event?.type !== "stage_started") continue;
    if (!Number.isInteger(event.seq) || event.seq < startSeq) continue;
    if (event.data?.runtime === INTEGRATE_RUNTIME_ID) continue;
    count += 1;
  }
  return count;
}

/** The enforcement event a breached run limit records. */
function limitEvent(stage, limit) {
  return {
    type: "enforcement",
    actor: ENGINE,
    data: { stage, rule: RUN_LIMIT_RULE, limit, violations: [] },
  };
}

/** The step outcome for a breached run limit. */
function limitOutcome(stage, limit) {
  return { status: STEP.ENFORCED, stage, rule: RUN_LIMIT_RULE, limit };
}

/**
 * Refuse to start a new agent once the run has spent its agent-start limit.
 * The check runs only where an agent would start, never on a poll, so a run at
 * its limit still waits for the agent it has already dispatched.
 */
function startLimitRefusal({ taskId, deps, log, stage }) {
  const limits = deps.runLimits;
  if (limits === null || typeof limits !== "object") return null;
  const max = limits.maxAgentStartsPerRun;
  if (!positiveInt(max)) return null;
  const observed = runAgentStarts(log.events, limits.startSeq);
  if (observed < max) return null;
  const limit = { name: RUN_LIMITS.STARTS, max, observed };
  append(deps, taskId, limitEvent(stage, limit));
  return limitOutcome(stage, limit);
}

/** The wall-clock limit a run has breached, or null when it is inside it. */
function wallLimitBreach({ deps, startedAt, limits }) {
  const max = limits?.maxWallMinutesPerRun;
  if (!positiveInt(max)) return null;
  const observed = (now(deps).getTime() - startedAt.getTime()) / 60000;
  if (observed < max) return null;
  return { name: RUN_LIMITS.WALL, max, observed };
}

/** The folded stage of a task, for an enforcement event with no step outcome. */
function foldedStage(deps, taskId) {
  return replay(deps.events.readEvents(deps.events.dir, taskId).events, deps.stages).stage;
}

/** The wall clock sleep an unattended loop uses between polls. */
function defaultSleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Throw unless the two mandatory dependencies are wired. */
function assertDeps(deps) {
  if (deps === null || typeof deps !== "object") {
    throw new Error("deps must be an object");
  }
  const { events, stages } = deps;
  if (
    events === null ||
    typeof events !== "object" ||
    typeof events.readEvents !== "function" ||
    typeof events.appendEvent !== "function"
  ) {
    throw new Error("deps.events must provide dir, readEvents and appendEvent");
  }
  if (
    stages === null ||
    typeof stages !== "object" ||
    typeof stages.initialState !== "function" ||
    typeof stages.transition !== "function"
  ) {
    throw new Error("deps.stages must be the stage machine (initialState, transition)");
  }
}

/**
 * Take one step of the lifecycle for `taskId` and return a plain outcome whose
 * `status` is one of `started`, `waiting`, `advanced`, `blocked`, `enforced`,
 * `failed` or `terminal`.
 *
 * One step: rebuild the state by replaying the log, and then, for the current
 * stage: complete it when the recorded runtime has settled with a zero exit code
 * (or an injected gate passes), otherwise poll an already-recorded handle, or
 * start the stage's runtime and record the handle first. An agent stage that
 * finished is passed through the injected path enforcement before it advances,
 * and an `integrate` stage is merged through the injected VCS with the current
 * log head as the run head.
 *
 * `deps` is the whole environment; it is injected so this module carries no
 * rules of its own:
 *
 *   - `events`: `{ dir, readEvents, appendEvent, headHash }`, the event log
 *     from scripts/lifecycle/events.js. `dir` is the log directory.
 *   - `stages`: the pure stage machine from scripts/lifecycle/stages.js
 *     (`initialState`, `transition`, `advanceId`, `RULES`, `STAGES`, `TERMINAL`).
 *   - `anchors`: `{ anchorStage(stage, taskId) -> { ok, anchor } }`, resolving
 *     the completed stage's committed artefact `{ path, commit }`.
 *   - `requiresHuman(transitionId, context) -> boolean`, the policy consulted
 *     through the stage machine before an agent edge is allowed.
 *   - `runtime(stage) -> runtime | null`, the runtime adapter for an agent
 *     stage, or null to mark the stage as a gate. The runtime implements
 *     `start`, `status`, `result` and `stop` as in scripts/lifecycle/runtime.js.
 *   - `runtimeId(stage) -> string`, optional; the id recorded in
 *     `stage_started.data.runtime` (falls back to the adapter's `name`).
 *   - `gate(stage, context) -> { ok, anchor? }`, optional; a gate stage's
 *     completion check. `context` is `{ taskId, state, log }`.
 *   - `enforce(context) -> { ok, violations?, rule? }`, optional; run after an
 *     agent stage finishes. `context` is `{ stage, taskId, state }`. A refusal
 *     is recorded as an `enforcement` event and stops the stage advancing; a
 *     later step returns that recorded refusal instead of appending another.
 *   - `decide(observation, history) -> decision`, optional; the diagnosis run
 *     after a failure. `history` is `{ stage, state, attempts, decisions, at }`.
 *     Without it the engine escalates, because choosing an intervention is not
 *     its job.
 *   - `vcs`: `{ merge(ref, base, { runHead }) -> { ok, sha?, error? },
 *     merged?(ref, base) -> true | { ok, sha? } }`, used on the `integrate`
 *     stage. `merged` is optional and lets a resumed integrate confirm that a
 *     crashed merge already happened.
 *   - `dispatch(stage, taskId) -> { actor, env?, worktree?, spec?, ref?, base?,
 *     anchor?, runtimeId? }`, optional; the per-stage launch context, used for
 *     the actor on `stage_done` and the merge arguments on `integrate`.
 *   - `clock() -> Date`, optional; used to stamp the diagnosis history and to
 *     measure the wall clock of a run.
 *   - `runLimits`: `{ startSeq, maxAgentStartsPerRun }`, optional; set by
 *     `runUntilBlocked` so a step refuses to start a further agent once the
 *     run has spent its agent-start limit (see `runUntilBlocked`).
 */
export async function step({ taskId, deps } = {}) {
  assertDeps(deps);
  const log = deps.events.readEvents(deps.events.dir, taskId);
  const state = replay(log.events, deps.stages);
  const stage = state.stage;

  if (isTerminal(stage, deps.stages)) {
    return { status: STEP.TERMINAL, stage };
  }
  if (stage === "integrate") {
    return integrateStage({ taskId, deps, state, log });
  }

  const runtime = runtimeFor(deps, stage);
  const open = openStage(log.events, stage);

  if (runtime !== null && open.handle !== null) {
    if (open.enforcement !== null) return enforcedOutcome(stage, open.enforcement);
    const inspected = await inspectRuntime(runtime, open.handle);
    if (!inspected.settled) return { status: STEP.WAITING, stage, handle: open.handle };
    if (inspected.ok) {
      return completeAgentStage({ taskId, deps, state, stage, runtime, result: inspected.result });
    }
    return failStage({
      taskId,
      deps,
      state,
      log,
      stage,
      runtimeId: runtimeName(deps, stage, runtime),
      observation: { stage, ...inspected.observation },
    });
  }

  if (runtime === null) {
    return gateStage({ taskId, deps, state, log, stage });
  }

  const refused = startLimitRefusal({ taskId, deps, log, stage });
  if (refused !== null) return refused;

  return startStage({ taskId, deps, stage, runtime });
}

/**
 * Loop `step` until the lifecycle is terminal, a stage needs a human, the
 * diagnosis escalates, or `maxSteps` is reached; an unattended loop instead
 * waits for a running stage and keeps driving the task until it is terminal,
 * needs a human, escalates or breaches a run limit. Returns
 * `{ status, stage?, rule?, limit?, outcome?, steps }`, where `steps` is every
 * outcome taken in order, so a caller can see exactly where the run stopped.
 *
 * `unattended: true` replaces the step cap with the run limits and polls a
 * running stage through the injected `sleep` instead of stopping on `waiting`.
 * An unattended loop therefore requires `limits.maxWallMinutesPerRun` to be a
 * positive integer: without a wall-clock bound the loop has no bound at all.
 *
 * `limits` is `{ maxWallMinutesPerRun, maxAgentStartsPerRun }`, each a positive
 * integer or null (unset). They bound one run: an elapsed wall clock at or over
 * the limit stops the run before the next step, and the run's agent starts
 * (the `stage_started` events it appended, excluding the `integrate` merge
 * marker) are counted so a further agent is never started once the limit is
 * spent. Either breach appends an `enforcement` event carrying
 * `rule: R-RUN-LIMIT` and the breached limit to the task's log, and returns
 * `status: "limit"`.
 */
export async function runUntilBlocked({
  taskId,
  deps,
  maxSteps = DEFAULT_MAX_STEPS,
  unattended = false,
  limits = null,
  sleep = defaultSleep,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  assertDeps(deps);
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error("maxSteps must be a positive integer");
  }
  if (unattended && !positiveInt(limits?.maxWallMinutesPerRun)) {
    throw new Error(
      "an unattended run needs a positive limits.maxWallMinutesPerRun; without one the loop is unbounded",
    );
  }
  if (unattended && typeof sleep !== "function") {
    throw new Error("sleep must be a function");
  }
  if (unattended && (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0)) {
    throw new Error("pollIntervalMs must be a non-negative integer");
  }

  const bounded = limits !== null && typeof limits === "object";
  const stepDeps = bounded
    ? {
        ...deps,
        runLimits: {
          startSeq: nextSeq(deps, taskId),
          maxAgentStartsPerRun: limits.maxAgentStartsPerRun,
        },
      }
    : deps;
  const startedAt = now(deps);
  const steps = [];
  const cap = unattended ? Number.POSITIVE_INFINITY : maxSteps;

  for (let i = 0; i < cap; i++) {
    if (bounded) {
      const breached = wallLimitBreach({ deps, startedAt, limits });
      if (breached !== null) {
        const stage = foldedStage(deps, taskId);
        append(deps, taskId, limitEvent(stage, breached));
        return { status: RUN.LIMIT, stage, rule: RUN_LIMIT_RULE, limit: breached, steps };
      }
    }

    const outcome = await step({ taskId, deps: stepDeps });
    steps.push(outcome);
    if (outcome.status === STEP.TERMINAL) {
      return { status: RUN.TERMINAL, stage: outcome.stage, outcome, steps };
    }
    if (outcome.status === STEP.BLOCKED) {
      return { status: RUN.BLOCKED, rule: outcome.rule, stage: outcome.stage, outcome, steps };
    }
    if (outcome.status === STEP.ENFORCED) {
      const status = outcome.rule === RUN_LIMIT_RULE ? RUN.LIMIT : RUN.BLOCKED;
      return {
        status,
        rule: outcome.rule,
        stage: outcome.stage,
        limit: outcome.limit,
        outcome,
        steps,
      };
    }
    if (outcome.status === STEP.WAITING) {
      if (!unattended) {
        return { status: RUN.WAITING, stage: outcome.stage, outcome, steps };
      }
      await sleep(pollIntervalMs);
      continue;
    }
    if (outcome.status === STEP.FAILED && isEscalation(outcome.decision)) {
      return { status: RUN.ESCALATED, stage: outcome.stage, outcome, steps };
    }
  }
  return { status: RUN.MAX_STEPS, steps };
}
