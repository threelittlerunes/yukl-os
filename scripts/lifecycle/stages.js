// Pure lifecycle stage machine for the yukl-os pipeline.
//
// The lifecycle is a fixed and ordered list of stages followed by three
// terminal states. This module holds no file system, git or clock access:
// it maps a state and an event to a next state and the id of the rule that
// decided the outcome, so the same inputs always produce the same result.
//
// An agent may only move the lifecycle forward by finishing the current
// stage with a `stage_done` event that anchors the work to a commit. A human
// may move it anywhere with a `human_decision` event, including pausing,
// resuming and stopping it. Everything else is refused.

export const STAGES = Object.freeze([
  "intent",
  "scope",
  "plan",
  "implement",
  "prove",
  "audit",
  "review",
  "integrate",
]);

export const TERMINAL = Object.freeze(["done", "stopped", "escalated"]);

export const R_ADVANCE_ANCHORED = "R-ADVANCE-ANCHORED";
export const R_NO_ANCHOR = "R-NO-ANCHOR";
export const R_SELF_APPROVAL = "R-SELF-APPROVAL";
export const R_TERMINAL = "R-TERMINAL";
export const R_NEEDS_HUMAN = "R-NEEDS-HUMAN";
export const R_HUMAN_OVERRIDE = "R-HUMAN-OVERRIDE";
export const R_ILLEGAL_EDGE = "R-ILLEGAL-EDGE";

export const RULES = Object.freeze({
  ADVANCE_ANCHORED: R_ADVANCE_ANCHORED,
  NO_ANCHOR: R_NO_ANCHOR,
  SELF_APPROVAL: R_SELF_APPROVAL,
  TERMINAL: R_TERMINAL,
  NEEDS_HUMAN: R_NEEDS_HUMAN,
  HUMAN_OVERRIDE: R_HUMAN_OVERRIDE,
  ILLEGAL_EDGE: R_ILLEGAL_EDGE,
});

const NEXT_STAGE = Object.freeze({
  intent: "scope",
  scope: "plan",
  plan: "implement",
  implement: "prove",
  prove: "audit",
  audit: "review",
  review: "integrate",
  integrate: "done",
});

const COMMIT_RE = /^[0-9a-f]{40}$/i;

/** The id an agent-driven edge is known by, e.g. `advance:scope->plan`. */
export function advanceId(from, to) {
  return `advance:${from}->${to}`;
}

/** A fresh lifecycle state at the first stage. */
export function initialState(overrides = {}) {
  return {
    stage: "intent",
    implementActors: [],
    paused: false,
    decisions: [],
    ...overrides,
  };
}

/**
 * Apply `event` to `state` and return `{ ok, next, rule }`.
 *
 * `requiresHuman` is injected so the engine carries no policy of its own: it
 * is called with the edge id and, when it returns true, an agent-driven edge
 * is refused. A refused result returns the input state untouched.
 */
export function transition(state, event, options = {}) {
  const { requiresHuman = () => false } = options;
  const stage = state?.stage;

  if (typeof requiresHuman !== "function") {
    return refuse(state, R_ILLEGAL_EDGE);
  }
  if (!isKnownStage(stage)) {
    return refuse(state, R_ILLEGAL_EDGE);
  }
  if (TERMINAL.includes(stage)) {
    return refuse(state, R_TERMINAL);
  }
  if (event?.type === "human_decision") {
    return byHuman(state, event);
  }
  if (event?.type === "stage_done") {
    return byAgent(state, event, requiresHuman);
  }
  return refuse(state, R_ILLEGAL_EDGE);
}

function byAgent(state, event, requiresHuman) {
  const from = state.stage;
  const actor = typeof event.actor === "string" ? event.actor.trim() : "";
  if (actor === "") return refuse(state, R_ILLEGAL_EDGE);

  const skipPlan = from === "scope" && event.data?.skipPlan === true;
  const decisionRule = event.decision?.rule;
  if (skipPlan && (typeof decisionRule !== "string" || decisionRule.trim() === "")) {
    return refuse(state, R_ILLEGAL_EDGE);
  }

  const to = skipPlan ? "implement" : NEXT_STAGE[from];
  if (event.stage !== undefined && event.stage !== to) {
    return refuse(state, R_ILLEGAL_EDGE);
  }
  if (!isAnchored(event.anchor)) {
    return refuse(state, R_NO_ANCHOR);
  }

  const implementActors = normaliseList(state.implementActors);
  if (from === "audit" && to === "review" && implementActors.includes(actor)) {
    return refuse(state, R_SELF_APPROVAL);
  }
  if (requiresHuman(advanceId(from, to))) {
    return refuse(state, R_NEEDS_HUMAN);
  }

  const next = {
    ...state,
    stage: to,
    paused: false,
    implementActors,
    decisions: normaliseList(state.decisions),
  };
  if (from === "implement" && !implementActors.includes(actor)) {
    next.implementActors = [...implementActors, actor];
  }
  if (skipPlan) {
    next.decisions = [...next.decisions, { from, to, rule: decisionRule.trim() }];
  }

  return allow(next, R_ADVANCE_ANCHORED);
}

function byHuman(state, event) {
  const target = event.stage;
  if (target !== undefined) {
    if (!isKnownStage(target)) return refuse(state, R_ILLEGAL_EDGE);
    return allow({ ...state, stage: target, paused: false }, R_HUMAN_OVERRIDE);
  }

  const action = event.action ?? event.data?.action;
  if (action === "pause") {
    return allow({ ...state, paused: true }, R_HUMAN_OVERRIDE);
  }
  if (action === "resume") {
    return allow({ ...state, paused: false }, R_HUMAN_OVERRIDE);
  }
  if (action === "stop") {
    return allow({ ...state, stage: "stopped", paused: false }, R_HUMAN_OVERRIDE);
  }
  return refuse(state, R_ILLEGAL_EDGE);
}

function isKnownStage(stage) {
  return STAGES.includes(stage) || TERMINAL.includes(stage);
}

function isAnchored(anchor) {
  return (
    anchor !== null &&
    typeof anchor === "object" &&
    typeof anchor.commit === "string" &&
    COMMIT_RE.test(anchor.commit)
  );
}

function normaliseList(value) {
  return Array.isArray(value) ? [...value] : [];
}

function allow(next, rule) {
  return { ok: true, next, rule };
}

function refuse(state, rule) {
  return { ok: false, next: state, rule };
}
