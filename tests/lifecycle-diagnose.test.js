import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORIES,
  RULES,
  assertDecision,
  chooseIntervention,
  classify,
  diagnose,
  hashInputs,
  stableJson,
} from "../scripts/lifecycle/diagnose.js";

const POLICY = { limits: { maxAttemptsPerStage: 3 } };

/** A diagnosis object for a given category, as `chooseIntervention` receives it. */
function diagnosisOf(category, observation = {}) {
  return { stage: "prove", category, observation };
}

/** An attempt record, as the engine would store it from a decision. */
function record(decision) {
  return {
    stage: decision.stage,
    category: decision.category,
    intervention: decision.intervention,
    inputHash: decision.inputHash,
  };
}

// ---------------------------------------------------------------------------
// classify: one category per observation
// ---------------------------------------------------------------------------

test("classify reads each failure signal into its category (known-good control)", () => {
  assert.equal(classify({ stage: "prove", proofFailed: true }), "implementation_defect");
  assert.equal(classify({ stage: "prove", exitCode: 1 }), "implementation_defect");
  assert.equal(classify({ stage: "prove", pathViolations: ["src/a.js"] }), "path_violation");
  assert.equal(
    classify({ stage: "plan", question: { text: "what is x?", namesOutsideSpec: true } }),
    "missing_context",
  );
  assert.equal(
    classify({ stage: "plan", question: { text: "is this the goal?", aboutIntent: true } }),
    "ambiguous_requirement",
  );
  assert.equal(
    classify({ stage: "prove", failingRules: ["R-A", "R-B"] }),
    "conflicting_constraints",
  );
  assert.equal(classify({ stage: "prove", timedOut: true }), "capability_limit");
  assert.equal(classify({ stage: "prove", runtimeRefused: true }), "capability_limit");
});

test("classify treats a clean observation as unclassified (known-good control)", () => {
  assert.equal(classify({ stage: "prove", exitCode: 0 }), "unclassified");
  assert.equal(classify({ stage: "prove" }), "unclassified");
  assert.equal(classify(null), "unclassified");
  assert.equal(classify(undefined), "unclassified");
});

test("classify applies one fixed precedence order when signals overlap", () => {
  assert.equal(
    classify({ stage: "prove", proofFailed: true, pathViolations: ["src/a.js"] }),
    "implementation_defect",
  );
  assert.equal(
    classify({ stage: "prove", pathViolations: ["src/a.js"], timedOut: true }),
    "path_violation",
  );
  assert.equal(
    classify({ stage: "prove", question: { namesOutsideSpec: true, aboutIntent: true } }),
    "missing_context",
  );
  assert.equal(
    classify({ stage: "prove", failingRules: ["R-A", "R-B"], timedOut: true }),
    "conflicting_constraints",
  );
  assert.equal(classify({ stage: "prove", failingRules: ["R-A"] }), "unclassified");
});

test("classify promotes only a repeated path violation", () => {
  const pathHistory = [{ stage: "prove", category: "path_violation" }];
  assert.equal(
    classify({ stage: "prove", pathViolations: ["src/a.js"] }, pathHistory),
    "repeated_violation",
  );

  const defectHistory = [{ stage: "prove", category: "implementation_defect" }];
  assert.equal(
    classify({ stage: "prove", proofFailed: true }, defectHistory),
    "implementation_defect",
  );
});

test("classify does not promote a different category or a different stage", () => {
  const history = [{ stage: "prove", category: "path_violation" }];
  assert.equal(
    classify({ stage: "audit", pathViolations: ["src/a.js"] }, history),
    "path_violation",
  );
  assert.equal(classify({ stage: "prove", pathViolations: ["src/a.js"] }, []), "path_violation");
});

// ---------------------------------------------------------------------------
// chooseIntervention: the first table entry on a clean history
// ---------------------------------------------------------------------------

test("each category yields its first table entry on a clean history (known-good control)", () => {
  const first = (category) => chooseIntervention(diagnosisOf(category), [], POLICY);

  assert.equal(first("implementation_defect").intervention, "retry");
  assert.equal(first("missing_context").intervention, "apprising");
  assert.equal(first("ambiguous_requirement").intervention, "consultation");
  assert.equal(first("conflicting_constraints").intervention, "consultation");
  assert.equal(first("capability_limit").intervention, "switch_runtime");

  const path = first("path_violation");
  assert.equal(path.kind, "deterministic");
  assert.equal(path.rule, RULES.PATH_SCOPE);
  assert.equal(path.intervention, "enforcement");

  const repeated = first("repeated_violation");
  assert.equal(repeated.kind, "deterministic");
  assert.equal(repeated.rule, RULES.REPEAT_VIOLATION);
  assert.equal(repeated.intervention, "enforcement");

  const unclassified = first("unclassified");
  assert.equal(unclassified.kind, "deterministic");
  assert.equal(unclassified.rule, RULES.UNCLASSIFIED);
  assert.equal(unclassified.intervention, "escalate");
});

test("every listed category yields a well-formed decision", () => {
  for (const category of CATEGORIES) {
    const decision = chooseIntervention(diagnosisOf(category), [], POLICY);
    assert.doesNotThrow(() => assertDecision(decision), category);
  }
});

test("an adaptive decision carries inputs and hashes them, not the observation alone", () => {
  const decision = chooseIntervention(diagnosisOf("implementation_defect"), [], POLICY);
  assert.equal(decision.kind, "adaptive");
  assert.equal(typeof decision.rationale, "string");
  assert.ok(decision.rationale.length > 0);
  assert.equal(decision.inputHash, hashInputs(decision.inputs));
  assert.equal(decision.attempt, 1);
});

// ---------------------------------------------------------------------------
// tactic-specific inputs
// ---------------------------------------------------------------------------

test("each tactic hashes its own inputs", () => {
  const observation = {
    stage: "prove",
    proofFailed: true,
    exitCode: 1,
    output: "boom",
    runtime: "alpha",
  };
  const first = chooseIntervention(diagnosisOf("implementation_defect", observation), [], POLICY);
  assert.equal(first.intervention, "retry");
  assert.equal(first.inputs.tactic, "rational persuasion");
  assert.deepEqual(first.inputs.failingOutput, {
    exitCode: 1,
    proofFailed: true,
    output: "boom",
  });

  const second = chooseIntervention(
    diagnosisOf("implementation_defect", observation),
    [record(first)],
    POLICY,
  );
  assert.equal(second.intervention, "apprising");
  assert.equal(second.inputs.tactic, "apprising");
  assert.equal(second.inputs.context.previousFailure, "implementation_defect");
  assert.notDeepEqual(second.inputs, first.inputs);

  const third = chooseIntervention(
    diagnosisOf("implementation_defect", observation),
    [record(first), record(second)],
    POLICY,
  );
  assert.equal(third.intervention, "collaboration");
  assert.equal(third.inputs.tactic, "collaboration");
  assert.deepEqual(third.inputs.runtimeSwitch, { from: "alpha", to: null });
  assert.notDeepEqual(third.inputs, second.inputs);
});

test("a runtime move carries the runtime switch", () => {
  const decision = chooseIntervention(
    diagnosisOf("capability_limit", { timedOut: true, runtime: "alpha", nextRuntime: "beta" }),
    [],
    POLICY,
  );
  assert.equal(decision.intervention, "switch_runtime");
  assert.deepEqual(decision.inputs.runtimeSwitch, { from: "alpha", to: "beta" });
});

// ---------------------------------------------------------------------------
// must-reject: an intervention is never retried with the same inputs
// ---------------------------------------------------------------------------

test("chooseIntervention never repeats the previous (intervention, inputHash) pair", () => {
  const diagnosis = diagnosisOf("implementation_defect", { proofFailed: true });
  const first = chooseIntervention(diagnosis, [], POLICY);
  assert.equal(first.intervention, "retry");
  assert.equal(typeof first.inputHash, "string");

  const history = [
    {
      stage: "prove",
      category: "implementation_defect",
      intervention: first.intervention,
      inputHash: first.inputHash,
    },
  ];
  const second = chooseIntervention(diagnosis, history, POLICY);
  assert.notEqual(second.intervention, "retry");
  assert.equal(second.intervention, "apprising");
});

test("chooseIntervention retries again when the failing output changes", () => {
  const first = chooseIntervention(
    diagnosisOf("implementation_defect", { exitCode: 1, output: "a" }),
    [],
    POLICY,
  );
  const history = [
    {
      stage: "prove",
      category: "implementation_defect",
      intervention: first.intervention,
      inputHash: first.inputHash,
    },
  ];
  const second = chooseIntervention(
    diagnosisOf("implementation_defect", { exitCode: 1, output: "b" }),
    history,
    POLICY,
  );
  assert.equal(second.intervention, "retry");
  assert.notEqual(second.inputHash, first.inputHash);
});

test("chooseIntervention walks the table and escalates when it is exhausted", () => {
  const diagnosis = diagnosisOf("implementation_defect", { proofFailed: true });
  const policy = { limits: { maxAttemptsPerStage: 10 } };
  const history = [];
  const tried = [];
  let decision = chooseIntervention(diagnosis, history, policy);
  for (let i = 0; i < 3; i++) {
    tried.push(decision.intervention);
    history.push({
      stage: "prove",
      category: "implementation_defect",
      intervention: decision.intervention,
      inputHash: decision.inputHash,
    });
    decision = chooseIntervention(diagnosis, history, policy);
  }
  assert.deepEqual(tried, ["retry", "apprising", "collaboration"]);
  assert.equal(decision.kind, "deterministic");
  assert.equal(decision.rule, RULES.TABLE_EXHAUSTED);
  assert.equal(decision.intervention, "escalate");
});

test("two consecutive implementation_defect failures get different interventions", () => {
  const observation = { stage: "prove", proofFailed: true, output: "boom" };
  const first = diagnose(observation, [], POLICY);
  assert.equal(first.category, "implementation_defect");
  assert.equal(first.intervention, "retry");
  assert.equal(first.tactic, "rational persuasion");

  const second = diagnose(observation, [record(first)], POLICY);
  assert.equal(second.category, "implementation_defect");
  assert.equal(second.kind, "adaptive");
  assert.equal(second.intervention, "apprising");
  assert.notEqual(second.intervention, first.intervention);
  assert.notEqual(second.inputHash, first.inputHash);

  const atLimit = [0, 1, 2].map((i) => ({
    stage: "prove",
    category: "implementation_defect",
    intervention: `tried-${i}`,
    inputHash: `h${i}`,
  }));
  const limited = diagnose(observation, atLimit, POLICY);
  assert.equal(limited.kind, "deterministic");
  assert.equal(limited.rule, RULES.ATTEMPT_LIMIT);
  assert.equal(limited.intervention, "escalate");
});

// ---------------------------------------------------------------------------
// must-reject: the per-stage attempt limit forces an escalation
// ---------------------------------------------------------------------------

test("chooseIntervention escalates when the stage reached its attempt limit (known-bad control)", () => {
  const history = [0, 1, 2].map((i) => ({
    stage: "prove",
    category: "implementation_defect",
    intervention: "apprising",
    inputHash: `h${i}`,
  }));
  const decision = chooseIntervention(
    diagnosisOf("implementation_defect", { proofFailed: true }),
    history,
    POLICY,
  );
  assert.equal(decision.kind, "deterministic");
  assert.equal(decision.rule, RULES.ATTEMPT_LIMIT);
  assert.equal(decision.intervention, "escalate");
  assert.equal(decision.attempt, 4);
});

test("chooseIntervention does not bound attempts without a policy", () => {
  const diagnosis = diagnosisOf("capability_limit", { timedOut: true });
  const first = chooseIntervention(diagnosis, [], {});
  const history = [
    { stage: "prove", intervention: first.intervention, inputHash: first.inputHash },
  ];
  const decision = chooseIntervention(diagnosis, history, {});
  assert.equal(decision.rule, RULES.TABLE_EXHAUSTED);
});

// ---------------------------------------------------------------------------
// must-reject: assertDecision guards the decision shape
// ---------------------------------------------------------------------------

test("assertDecision accepts valid decisions and returns them (known-good control)", () => {
  const adaptive = chooseIntervention(diagnosisOf("implementation_defect"), [], POLICY);
  assert.equal(assertDecision(adaptive), adaptive);
  const deterministic = chooseIntervention(diagnosisOf("path_violation"), [], POLICY);
  assert.equal(assertDecision(deterministic), deterministic);
});

test("assertDecision rejects an adaptive decision with a missing or blank rationale (known-bad control)", () => {
  assert.throws(
    () => assertDecision({ kind: "adaptive", inputs: {}, intervention: "retry" }),
    /rationale/,
  );
  assert.throws(
    () => assertDecision({ kind: "adaptive", inputs: {}, rationale: "  " }),
    /rationale/,
  );
  assert.throws(() => assertDecision({ kind: "adaptive", rationale: "because" }), /inputs/);
});

test("assertDecision rejects a deterministic decision with no rule and an unknown kind", () => {
  assert.throws(() => assertDecision({ kind: "deterministic" }), /rule/);
  assert.throws(() => assertDecision({ kind: "deterministic", rule: "" }), /rule/);
  assert.throws(() => assertDecision({ kind: "guess" }), /kind/);
  assert.throws(() => assertDecision(null), /object/);
});

// ---------------------------------------------------------------------------
// diagnose: classify and choose in one step
// ---------------------------------------------------------------------------

test("diagnose classifies and chooses in one step", () => {
  const decision = diagnose({ stage: "prove", proofFailed: true }, [], POLICY);
  assert.equal(decision.kind, "adaptive");
  assert.equal(decision.intervention, "retry");
  assert.equal(decision.category, "implementation_defect");
  assert.equal(assertDecision(decision), decision);
});

test("diagnose stops a repeated path violation with enforcement", () => {
  const history = [{ stage: "prove", category: "path_violation" }];
  const decision = diagnose({ stage: "prove", pathViolations: ["src/a.js"] }, history, POLICY);
  assert.equal(decision.kind, "deterministic");
  assert.equal(decision.rule, RULES.REPEAT_VIOLATION);
  assert.equal(decision.intervention, "enforcement");
});

test("chooseIntervention classifies a diagnosis without a category, with history", () => {
  const history = [{ stage: "prove", category: "path_violation" }];
  const decision = chooseIntervention(
    { stage: "prove", observation: { pathViolations: ["src/a.js"] } },
    history,
    POLICY,
  );
  assert.equal(decision.category, "repeated_violation");
  assert.equal(decision.rule, RULES.REPEAT_VIOLATION);
});

// ---------------------------------------------------------------------------
// hashing: stable JSON, no clock
// ---------------------------------------------------------------------------

test("hashInputs is stable across key order and separates different inputs", () => {
  assert.equal(stableJson({ b: 1, a: [2, 3] }), stableJson({ a: [2, 3], b: 1 }));
  assert.equal(hashInputs({ b: 1, a: [2, 3] }), hashInputs({ a: [2, 3], b: 1 }));
  assert.equal(hashInputs({ a: [2, 3] }), hashInputs({ a: [2, 3] }));
  assert.notEqual(hashInputs({ a: 1 }), hashInputs({ a: 2 }));
  assert.match(hashInputs({}), /^[0-9a-f]{64}$/);
});
