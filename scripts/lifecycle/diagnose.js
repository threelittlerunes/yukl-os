// Deterministic failure diagnosis and intervention choice for the lifecycle.
//
// A stage that fails twice for the same reason must not be retried the same way
// forever, and a caller should not have to decide by hand what to try next.
// This module answers two questions with pure functions. `classify` reads one
// failure observation and returns a single category. `chooseIntervention` walks
// a table of Yukl influence tactics for that category and returns either an
// adaptive decision (the tactic to try, the inputs it needs and a rationale) or
// a deterministic one (a rule that forces the outcome, such as a path-scope
// stop). There is no clock, network or language model, so the same inputs
// always produce the same decision.
//
// An intervention is never repeated blindly. The engine records, for every
// attempt, the intervention it chose and the SHA-256 of that intervention's
// inputs; before returning a table entry, `chooseIntervention` compares both
// against every attempt already recorded for the stage and moves down the table
// when they match. Running out of table entries, reaching the per-stage attempt
// limit or failing to classify at all all end in an escalation rather than
// another try.
//
// History is an array of attempt records, oldest first, each shaped
// `{ stage, category, intervention, inputHash }`, where `category` is a
// `classify` result and `intervention`/`inputHash` are copied from the decision
// that was taken. Entries without a stage are not filtered out, so a caller
// that never records stages still gets the previous attempt. An optional
// `baseCategory` field wins over `category` when detecting a repetition.

import { createHash } from "node:crypto";

/** Every category `classify` can return, in precedence order. */
export const CATEGORIES = Object.freeze([
  "implementation_defect",
  "path_violation",
  "missing_context",
  "ambiguous_requirement",
  "conflicting_constraints",
  "capability_limit",
  "repeated_violation",
  "unclassified",
]);

/** Every intervention `chooseIntervention` can return. */
export const INTERVENTIONS = Object.freeze([
  "retry",
  "apprising",
  "collaboration",
  "consultation",
  "switch_runtime",
  "enforcement",
  "escalate",
]);

/** Deterministic rules carried by a `{ kind: "deterministic" }` decision. */
export const RULES = Object.freeze({
  ATTEMPT_LIMIT: "R-ATTEMPT-LIMIT",
  UNCLASSIFIED: "R-UNCLASSIFIED",
  TABLE_EXHAUSTED: "R-TABLE-EXHAUSTED",
  PATH_SCOPE: "R-PATH-SCOPE",
  REPEAT_VIOLATION: "R-REPEAT-VIOLATION",
});

// The tactic table. A category maps to the interventions to try, in order; the
// first entry is the default on a clean history. An entry carrying a `rule` is
// a deterministic stop rather than an adaptive try.
const TABLE = Object.freeze({
  implementation_defect: Object.freeze([
    adaptiveEntry(
      "retry",
      "rational persuasion",
      "re-run the failing proof with its captured output",
    ),
    adaptiveEntry("apprising", "apprising", "tell the agent about the context its attempt lacked"),
    adaptiveEntry("collaboration", "collaboration", "retry the stage on a second runtime"),
  ]),
  missing_context: Object.freeze([
    adaptiveEntry(
      "apprising",
      "apprising",
      "supply the file or term the question named outside the spec",
    ),
  ]),
  ambiguous_requirement: Object.freeze([
    adaptiveEntry(
      "consultation",
      "consultation",
      "ask the human to settle what the requirement means",
    ),
  ]),
  conflicting_constraints: Object.freeze([
    adaptiveEntry(
      "consultation",
      "consultation",
      "ask the human to choose between the conflicting rules",
    ),
  ]),
  capability_limit: Object.freeze([
    adaptiveEntry("switch_runtime", "collaboration", "run the stage on a different runtime"),
  ]),
  path_violation: Object.freeze([
    stopEntry("enforcement", RULES.PATH_SCOPE, "a path-scope violation stops the stage"),
  ]),
  repeated_violation: Object.freeze([
    stopEntry("enforcement", RULES.REPEAT_VIOLATION, "a repeated failure stops the stage"),
  ]),
});

function adaptiveEntry(intervention, tactic, rationale) {
  return Object.freeze({ intervention, tactic, rationale });
}

function stopEntry(intervention, rule, rationale) {
  return Object.freeze({ intervention, tactic: "pressure", rule, rationale });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Stable JSON for hashing: object keys are sorted, array order is kept and
 * `undefined` becomes `null`, so two structurally equal inputs always serialise
 * to the same bytes.
 */
export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

/** SHA-256 (lower-case hex) of the stable JSON of `inputs`. */
export function hashInputs(inputs) {
  return createHash("sha256").update(stableJson(inputs), "utf8").digest("hex");
}

/** Coerce a history argument into the attempt-record shape used below. */
function normaliseHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.map((entry) => {
    if (typeof entry === "string") return { category: entry };
    if (!isPlainObject(entry)) return {};
    const decision = isPlainObject(entry.decision) ? entry.decision : {};
    return {
      stage: typeof entry.stage === "string" ? entry.stage : undefined,
      category: entry.category ?? decision.category ?? entry.baseCategory ?? undefined,
      baseCategory: entry.baseCategory ?? undefined,
      intervention: entry.intervention ?? decision.intervention ?? undefined,
      inputHash: entry.inputHash ?? decision.inputHash ?? undefined,
    };
  });
}

/** History entries that belong to `stage`, keeping entries with no stage. */
function forStage(entries, stage) {
  if (stage == null) return entries;
  return entries.filter((entry) => entry.stage === undefined || entry.stage === stage);
}

/** The last attempt for `stage`, or null. */
function previousAttempt(history, stage) {
  const entries = forStage(normaliseHistory(history), stage);
  return entries.length === 0 ? null : entries[entries.length - 1];
}

/** The set of intervention and input-hash pairs already attempted. */
function triedPairs(history, stage) {
  const pairs = new Set();
  for (const entry of forStage(normaliseHistory(history), stage)) {
    if (entry.intervention != null && entry.inputHash != null) {
      pairs.add(`${entry.intervention}\u0000${entry.inputHash}`);
    }
  }
  return pairs;
}

/**
 * Classify one failure observation into a single category.
 *
 * Signals are checked in one fixed order and the first match wins, so an
 * observation carrying several signals is decided by the first of:
 * implementation_defect (a proof command failed), path_violation (the change
 * left the intent scope), missing_context (a question names a file or term
 * outside the spec), ambiguous_requirement (a question is about intent),
 * conflicting_constraints (two or more failing rules), capability_limit (the
 * run timed out or the runtime refused). Anything else is unclassified. A
 * non-unclassified base category that matches the previous failure for the same
 * stage is promoted to repeated_violation.
 */
export function classify(observation, history = []) {
  const obs = isPlainObject(observation) ? observation : {};
  const stage = typeof obs.stage === "string" ? obs.stage : null;

  let base = "unclassified";
  if (obs.proofFailed === true || (Number.isInteger(obs.exitCode) && obs.exitCode !== 0)) {
    base = "implementation_defect";
  } else if (Array.isArray(obs.pathViolations) && obs.pathViolations.length > 0) {
    base = "path_violation";
  } else if (isPlainObject(obs.question) && obs.question.namesOutsideSpec === true) {
    base = "missing_context";
  } else if (isPlainObject(obs.question) && obs.question.aboutIntent === true) {
    base = "ambiguous_requirement";
  } else if (Array.isArray(obs.failingRules) && obs.failingRules.length >= 2) {
    base = "conflicting_constraints";
  } else if (obs.timedOut === true || obs.runtimeRefused === true) {
    base = "capability_limit";
  }

  if (base !== "unclassified") {
    const previous = previousAttempt(history, stage);
    const previousCategory = previous ? (previous.baseCategory ?? previous.category) : null;
    if (previousCategory === base) return "repeated_violation";
  }
  return base;
}

/** Coerce a diagnosis argument into `{ stage, category, observation }`. */
function normaliseDiagnosis(diagnosis) {
  if (typeof diagnosis === "string") {
    return { stage: null, category: diagnosis, observation: null };
  }
  if (!isPlainObject(diagnosis)) {
    return { stage: null, category: "unclassified", observation: null };
  }
  const category =
    typeof diagnosis.category === "string" ? diagnosis.category : classify(diagnosis);
  return {
    stage: typeof diagnosis.stage === "string" ? diagnosis.stage : null,
    category,
    observation: diagnosis.observation ?? diagnosis,
  };
}

/** The positive per-stage attempt limit in `policy`, or null when unset. */
function attemptLimit(policy) {
  const limit = policy?.limits?.maxAttemptsPerStage;
  return Number.isInteger(limit) && limit > 0 ? limit : null;
}

/** The inputs a tactic would run with; hashed to detect a repeated attempt. */
function buildInputs(diagnosis) {
  return {
    stage: diagnosis.stage,
    category: diagnosis.category,
    observation: diagnosis.observation ?? null,
  };
}

function deterministic(fields, rule, intervention, rationale) {
  return {
    kind: "deterministic",
    stage: fields.stage,
    attempt: fields.attempt,
    category: fields.category,
    intervention,
    rule,
    rationale,
  };
}

function adaptive(fields, entry, inputs, inputHash) {
  return {
    kind: "adaptive",
    stage: fields.stage,
    attempt: fields.attempt,
    category: fields.category,
    intervention: entry.intervention,
    tactic: entry.tactic,
    inputs,
    rationale: entry.rationale,
    inputHash,
  };
}

/**
 * Choose the next intervention for a diagnosis.
 *
 * `diagnosis` is `{ stage, category, observation }`, a bare category string, or
 * a raw observation (which is classified here). `history` is as described at
 * the top of the file and `policy` supplies `limits.maxAttemptsPerStage`.
 *
 * The per-stage attempt limit is checked first and always escalates. An
 * unclassified failure escalates. Otherwise the category's table is walked in
 * order and the first entry whose `(intervention, inputHash)` pair has not
 * already been attempted for the stage is returned; an entry carrying a `rule`
 * returns a deterministic stop, an entry without one returns an adaptive
 * decision. A table with no usable entry left escalates with
 * `R-TABLE-EXHAUSTED`.
 */
export function chooseIntervention(diagnosis, history = [], policy = {}) {
  const record = normaliseDiagnosis(diagnosis);
  const attempts = forStage(normaliseHistory(history), record.stage).length;
  const fields = { stage: record.stage, attempt: attempts + 1, category: record.category };

  const limit = attemptLimit(policy);
  if (limit !== null && attempts >= limit) {
    return deterministic(
      fields,
      RULES.ATTEMPT_LIMIT,
      "escalate",
      "the stage reached its attempt limit",
    );
  }
  if (record.category === "unclassified") {
    return deterministic(
      fields,
      RULES.UNCLASSIFIED,
      "escalate",
      "the failure did not match a known category",
    );
  }

  const entries = TABLE[record.category];
  if (!entries) {
    return deterministic(
      fields,
      RULES.UNCLASSIFIED,
      "escalate",
      "the failure did not match a known category",
    );
  }

  const tried = triedPairs(history, record.stage);
  const inputs = buildInputs(record);
  const inputHash = hashInputs(inputs);
  for (const entry of entries) {
    if (entry.rule) return deterministic(fields, entry.rule, entry.intervention, entry.rationale);
    if (tried.has(`${entry.intervention}\u0000${inputHash}`)) continue;
    return adaptive(fields, entry, inputs, inputHash);
  }
  return deterministic(
    fields,
    RULES.TABLE_EXHAUSTED,
    "escalate",
    "every intervention for the category was already tried",
  );
}

/**
 * Classify an observation and choose its intervention in one step. Returns the
 * decision that `chooseIntervention` would have returned for the classification.
 */
export function diagnose(observation, history = [], policy = {}) {
  const obs = isPlainObject(observation) ? observation : {};
  const stage = typeof obs.stage === "string" ? obs.stage : null;
  return chooseIntervention(
    { stage, category: classify(obs, history), observation: obs },
    history,
    policy,
  );
}

/**
 * Throw unless `decision` is a well-formed decision. A deterministic decision
 * needs a non-empty `rule`; an adaptive decision needs `inputs` and a non-empty
 * `rationale`. Returns the decision unchanged so the check can be used inline.
 */
export function assertDecision(decision) {
  if (!isPlainObject(decision)) {
    throw new Error("decision must be an object");
  }
  if (decision.kind === "deterministic") {
    if (typeof decision.rule !== "string" || decision.rule.trim() === "") {
      throw new Error("a deterministic decision needs a non-empty rule");
    }
    return decision;
  }
  if (decision.kind === "adaptive") {
    if (decision.inputs === null || typeof decision.inputs !== "object") {
      throw new Error("an adaptive decision needs inputs");
    }
    if (typeof decision.rationale !== "string" || decision.rationale.trim() === "") {
      throw new Error("an adaptive decision needs a non-empty rationale");
    }
    return decision;
  }
  throw new Error('decision.kind must be "adaptive" or "deterministic"');
}
