import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAGES,
  TERMINAL,
  RULES,
  advanceId,
  initialState,
  transition,
} from "../scripts/lifecycle/stages.js";

const ANCHOR = { commit: "a".repeat(40) };

function agentEvent(actor, extra = {}) {
  return { type: "stage_done", actor, anchor: ANCHOR, ...extra };
}

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

test("STAGES holds the lifecycle stages in order", () => {
  assert.deepEqual(STAGES, [
    "intent",
    "scope",
    "plan",
    "implement",
    "prove",
    "audit",
    "review",
    "integrate",
  ]);
});

test("TERMINAL holds the terminal states", () => {
  assert.deepEqual(TERMINAL, ["done", "stopped", "escalated"]);
});

test("advance ids name both ends of the edge", () => {
  assert.equal(advanceId("intent", "scope"), "advance:intent->scope");
  assert.equal(advanceId("integrate", "done"), "advance:integrate->done");
});

// ---------------------------------------------------------------------------
// control: the happy path
// ---------------------------------------------------------------------------

test("the full happy path reaches done when every edge is anchored", () => {
  const edges = [
    ["intent", "scope", "agent-intent"],
    ["scope", "plan", "agent-scope"],
    ["plan", "implement", "agent-plan"],
    ["implement", "prove", "agent-implement"],
    ["prove", "audit", "agent-prove"],
    ["audit", "review", "agent-audit"],
    ["review", "integrate", "agent-review"],
    ["integrate", "done", "agent-integrate"],
  ];

  let state = initialState();
  for (const [from, to, actor] of edges) {
    assert.equal(state.stage, from, `expected to be at ${from}`);
    const result = transition(state, agentEvent(actor));
    assert.equal(result.ok, true, `${from} -> ${to} must be allowed`);
    assert.equal(result.rule, RULES.ADVANCE_ANCHORED);
    assert.equal(result.next.stage, to);
    state = result.next;
  }

  assert.equal(state.stage, "done");
  assert.deepEqual(state.implementActors, ["agent-implement"]);
});

test("a known-good anchor on the first edge is accepted", () => {
  const result = transition(initialState(), agentEvent("agent-intent"));
  assert.equal(result.ok, true);
  assert.equal(result.rule, RULES.ADVANCE_ANCHORED);
});

// ---------------------------------------------------------------------------
// must reject: a stage_done without an anchor
// ---------------------------------------------------------------------------

test("an agent stage_done without an anchor is refused", () => {
  const state = initialState();
  const result = transition(state, { type: "stage_done", actor: "agent-intent" });
  assert.equal(result.ok, false);
  assert.equal(result.rule, RULES.NO_ANCHOR);
  assert.equal(result.next, state, "a refused edge must not move the state");
});

test("an agent stage_done with a malformed commit is refused", () => {
  const badAnchors = [
    {},
    { commit: null },
    { commit: "" },
    { commit: "not a commit" },
    { commit: "a".repeat(39) },
    { commit: "a".repeat(41) },
    { commit: "z".repeat(40) },
  ];
  for (const anchor of badAnchors) {
    const result = transition(initialState(), {
      type: "stage_done",
      actor: "agent-intent",
      anchor,
    });
    assert.equal(result.ok, false, `${JSON.stringify(anchor)} must be refused`);
    assert.equal(result.rule, RULES.NO_ANCHOR);
  }
});

// ---------------------------------------------------------------------------
// must reject: a self-approving verdict
// ---------------------------------------------------------------------------

test("a verdict from an implement actor is refused at audit", () => {
  const state = initialState({ stage: "audit", implementActors: ["agent-implement"] });
  const result = transition(state, agentEvent("agent-implement"));
  assert.equal(result.ok, false);
  assert.equal(result.rule, RULES.SELF_APPROVAL);
});

test("a padded implement actor is still refused at audit", () => {
  const state = initialState({ stage: "audit", implementActors: [" agent-x"] });
  const result = transition(state, agentEvent("agent-x"));
  assert.equal(result.ok, false);
  assert.equal(result.rule, RULES.SELF_APPROVAL);
});

test("a known-good verdict from a different actor is accepted", () => {
  const state = initialState({ stage: "audit", implementActors: ["agent-implement"] });
  const result = transition(state, agentEvent("agent-audit"));
  assert.equal(result.ok, true);
  assert.equal(result.rule, RULES.ADVANCE_ANCHORED);
  assert.equal(result.next.stage, "review");
});

// ---------------------------------------------------------------------------
// must reject: any edge out of a closed state (done or stopped)
// ---------------------------------------------------------------------------

test("no edge leaves done or stopped", () => {
  const leaving = [
    { type: "stage_done", actor: "agent-done", anchor: ANCHOR },
    { type: "human_decision", action: "pause" },
    { type: "human_decision", stage: "implement" },
  ];
  for (const terminal of ["done", "stopped"]) {
    for (const event of leaving) {
      const state = initialState({ stage: terminal });
      const result = transition(state, event);
      assert.equal(result.ok, false, `${terminal} + ${event.type} must be refused`);
      assert.equal(result.rule, RULES.TERMINAL);
    }
  }
});

// ---------------------------------------------------------------------------
// escalated is a human exit, not a dead end
// ---------------------------------------------------------------------------

test("a human override out of escalated is accepted", () => {
  const state = initialState({ stage: "escalated" });
  const result = transition(state, {
    type: "human_decision",
    stage: "implement",
    actor: "human",
  });
  assert.equal(result.ok, true);
  assert.equal(result.rule, RULES.HUMAN_OVERRIDE);
  assert.equal(result.next.stage, "implement");
});

test("an agent stage_done out of escalated is refused", () => {
  const state = initialState({ stage: "escalated" });
  const result = transition(state, agentEvent("agent-escalated"));
  assert.equal(result.ok, false);
  assert.equal(result.rule, RULES.TERMINAL);
});

test("a human may resume or stop out of escalated", () => {
  const resumed = transition(initialState({ stage: "escalated", paused: true }), {
    type: "human_decision",
    action: "resume",
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.rule, RULES.HUMAN_OVERRIDE);
  assert.equal(resumed.next.stage, "escalated");
  assert.equal(resumed.next.paused, false);

  const stopped = transition(initialState({ stage: "escalated" }), {
    type: "human_decision",
    action: "stop",
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.rule, RULES.HUMAN_OVERRIDE);
  assert.equal(stopped.next.stage, "stopped");
});

// ---------------------------------------------------------------------------
// must reject: an override event that is not a human_decision
// ---------------------------------------------------------------------------

test("an override that is not a human_decision event is refused", () => {
  const state = initialState({ stage: "prove" });
  const impostors = [
    { type: "override", stage: "implement", actor: "human" },
    { type: "agent_decision", stage: "implement", actor: "human" },
    { type: "human", stage: "implement" },
    { type: "stage_done", actor: "agent-prove", anchor: ANCHOR, stage: "implement" },
  ];
  for (const event of impostors) {
    const result = transition(state, event);
    assert.equal(result.ok, false, `${event.type} must be refused`);
    assert.equal(result.rule, RULES.ILLEGAL_EDGE);
  }
});

// ---------------------------------------------------------------------------
// control: a human override
// ---------------------------------------------------------------------------

test("a human override from prove back to implement is allowed", () => {
  const state = initialState({ stage: "prove" });
  const result = transition(state, {
    type: "human_decision",
    stage: "implement",
    actor: "human",
  });
  assert.equal(result.ok, true);
  assert.equal(result.rule, RULES.HUMAN_OVERRIDE);
  assert.equal(result.next.stage, "implement");
});

// ---------------------------------------------------------------------------
// skipping the plan stage
// ---------------------------------------------------------------------------

test("scope can skip the plan stage when a decision rule is given", () => {
  const state = initialState({ stage: "scope" });
  const result = transition(
    state,
    agentEvent("agent-scope", {
      data: { skipPlan: true },
      decision: { rule: "plan-not-required" },
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.rule, RULES.ADVANCE_ANCHORED);
  assert.equal(result.next.stage, "implement");
  assert.deepEqual(result.next.decisions, [
    { from: "scope", to: "implement", rule: "plan-not-required" },
  ]);
});

test("scope reaches plan when the event does not ask to skip", () => {
  const result = transition(initialState({ stage: "scope" }), agentEvent("agent-scope"));
  assert.equal(result.ok, true);
  assert.equal(result.next.stage, "plan");
  assert.deepEqual(result.next.decisions, []);
});

test("a skip request without a decision rule is refused", () => {
  const state = initialState({ stage: "scope" });
  const result = transition(state, agentEvent("agent-scope", { data: { skipPlan: true } }));
  assert.equal(result.ok, false);
  assert.equal(result.rule, RULES.ILLEGAL_EDGE);
});

// ---------------------------------------------------------------------------
// injected human-authority policy
// ---------------------------------------------------------------------------

test("requiresHuman refuses an agent edge it names", () => {
  const seen = [];
  const requiresHuman = (id) => {
    seen.push(id);
    return id === advanceId("implement", "prove");
  };
  const state = initialState({ stage: "implement" });
  const result = transition(state, agentEvent("agent-implement"), { requiresHuman });
  assert.equal(result.ok, false);
  assert.equal(result.rule, RULES.NEEDS_HUMAN);
  assert.deepEqual(seen, ["advance:implement->prove"]);
});

test("an agent edge passes when requiresHuman does not claim it", () => {
  const state = initialState({ stage: "implement" });
  const result = transition(state, agentEvent("agent-implement"), {
    requiresHuman: () => false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.next.stage, "prove");
});

// ---------------------------------------------------------------------------
// pause, resume and stop
// ---------------------------------------------------------------------------

test("pause keeps the stage and sets the paused flag", () => {
  const result = transition(initialState({ stage: "implement" }), {
    type: "human_decision",
    action: "pause",
  });
  assert.equal(result.ok, true);
  assert.equal(result.rule, RULES.HUMAN_OVERRIDE);
  assert.equal(result.next.stage, "implement");
  assert.equal(result.next.paused, true);
});

test("resume keeps the stage and clears the paused flag", () => {
  const result = transition(initialState({ stage: "implement", paused: true }), {
    type: "human_decision",
    action: "resume",
  });
  assert.equal(result.ok, true);
  assert.equal(result.rule, RULES.HUMAN_OVERRIDE);
  assert.equal(result.next.stage, "implement");
  assert.equal(result.next.paused, false);
});

test("stop moves the lifecycle to the stopped state", () => {
  const result = transition(initialState({ stage: "review" }), {
    type: "human_decision",
    action: "stop",
  });
  assert.equal(result.ok, true);
  assert.equal(result.rule, RULES.HUMAN_OVERRIDE);
  assert.equal(result.next.stage, "stopped");
});

test("a human_decision with no recognised action is refused", () => {
  const state = initialState({ stage: "implement" });
  for (const event of [{ type: "human_decision", action: "rewind" }, { type: "human_decision" }]) {
    const result = transition(state, event);
    assert.equal(result.ok, false);
    assert.equal(result.rule, RULES.ILLEGAL_EDGE);
  }
});

// ---------------------------------------------------------------------------
// other refusals and purity
// ---------------------------------------------------------------------------

test("an unknown event type is refused", () => {
  const result = transition(initialState(), { type: "nonsense" });
  assert.equal(result.ok, false);
  assert.equal(result.rule, RULES.ILLEGAL_EDGE);
});

test("a stage_done that jumps to a non-adjacent stage is refused", () => {
  const result = transition(
    initialState({ stage: "intent" }),
    agentEvent("agent-intent", { stage: "integrate" }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.rule, RULES.ILLEGAL_EDGE);
});

test("an unknown current stage is refused", () => {
  const result = transition({ stage: "limbo", implementActors: [] }, agentEvent("agent-limbo"));
  assert.equal(result.ok, false);
  assert.equal(result.rule, RULES.ILLEGAL_EDGE);
});

test("a stage_done without an actor is refused", () => {
  const result = transition(initialState(), { type: "stage_done", anchor: ANCHOR });
  assert.equal(result.ok, false);
  assert.equal(result.rule, RULES.ILLEGAL_EDGE);
});

test("transition does not mutate the input state", () => {
  const state = initialState({ stage: "implement", decisions: [] });
  const snapshot = structuredClone(state);
  const result = transition(state, agentEvent("agent-implement"));
  assert.equal(result.ok, true);
  assert.deepEqual(state, snapshot);
  assert.notEqual(result.next, state);
});

test("transition is deterministic for the same state and event", () => {
  const state = initialState({ stage: "audit", implementActors: ["agent-implement"] });
  const event = agentEvent("agent-audit");
  assert.deepEqual(transition(state, event), transition(state, event));
});
