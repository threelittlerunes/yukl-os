#!/usr/bin/env node
// Autonomy policy for the Yukl Power Harness.
//
// yukl.policy.json records which SDLC transitions an agent may take without a
// human, up to which track-record level, and under which run budgets. This
// module is the single loader and schema checker: `loadPolicy` reads the
// policy from a base ref (argument-array `git show`, never a shell) or, as a
// local preview, from the working tree; the pure helpers `policyViolations`,
// `requiresHuman` and `unattendedAllowed` carry the trust decisions so callers
// never have to re-implement them.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const POLICY_PATH = "yukl.policy.json";

const BUDGET_KEYS = ["maxWallMinutesPerRun", "maxTokensPerRun", "maxAgentStartsPerRun"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Schema checks for yukl.policy.json. Returns an array of violation strings
 * (empty array = valid):
 *   - `autonomy` maps a transition id to "human", "auto" or
 *     `{ auto_at_level: <integer >= 1> }`
 *   - `ceiling` is an integer >= 0
 *   - `limits.maxAttemptsPerStage` is an integer >= 1
 *   - `budgets.maxWallMinutesPerRun`, `maxTokensPerRun` and
 *     `maxAgentStartsPerRun` are each a positive integer or null
 *   - `trackRecord.levels` is an array of `{ level, minCleanRuns }` entries,
 *     each a non-negative integer
 */
export function policyViolations(doc) {
  const violations = [];
  if (!isPlainObject(doc)) {
    return ["policy root must be a JSON object"];
  }

  if (!Number.isInteger(doc.ceiling) || doc.ceiling < 0) {
    violations.push("ceiling must be an integer >= 0");
  }

  if (!isPlainObject(doc.autonomy)) {
    violations.push(
      'autonomy must be an object mapping transition ids to "human", "auto" or { auto_at_level }',
    );
  } else {
    for (const [id, entry] of Object.entries(doc.autonomy)) {
      if (entry === "human" || entry === "auto") continue;
      if (isPlainObject(entry)) {
        if (!Number.isInteger(entry.auto_at_level) || entry.auto_at_level < 1) {
          violations.push(`autonomy.${id}.auto_at_level must be an integer >= 1`);
        }
      } else {
        violations.push(`autonomy.${id} must be "human", "auto" or { auto_at_level }`);
      }
    }
  }

  if (!isPlainObject(doc.limits)) {
    violations.push("limits must be an object");
  } else if (
    !Number.isInteger(doc.limits.maxAttemptsPerStage) ||
    doc.limits.maxAttemptsPerStage < 1
  ) {
    violations.push("limits.maxAttemptsPerStage must be an integer >= 1");
  }

  if (!isPlainObject(doc.budgets)) {
    violations.push("budgets must be an object");
  } else {
    for (const key of BUDGET_KEYS) {
      const value = doc.budgets[key];
      if (value === null) continue;
      if (!Number.isInteger(value) || value <= 0) {
        violations.push(`budgets.${key} must be a positive integer or null`);
      }
    }
  }

  if (!isPlainObject(doc.trackRecord)) {
    violations.push("trackRecord must be an object");
  } else if (!Array.isArray(doc.trackRecord.levels)) {
    violations.push("trackRecord.levels must be an array");
  } else {
    doc.trackRecord.levels.forEach((entry, i) => {
      const at = `trackRecord.levels[${i}]`;
      if (!isPlainObject(entry)) {
        violations.push(`${at} must be an object`);
        return;
      }
      if (!Number.isInteger(entry.level) || entry.level < 0) {
        violations.push(`${at}.level must be an integer >= 0`);
      }
      if (!Number.isInteger(entry.minCleanRuns) || entry.minCleanRuns < 0) {
        violations.push(`${at}.minCleanRuns must be an integer >= 0`);
      }
    });
  }

  return violations;
}

/**
 * Read the policy and check its schema in one step. With `base` the document
 * is read from that ref via `git show` (argument array, no shell), so a pull
 * request cannot widen its own autonomy; without `base` the working tree is
 * read, which makes local mode a developer preview rather than a trust
 * boundary. Returns `{ ok, policy, errors }`: `policy` is the parsed document
 * when one could be read, otherwise null; `errors` is empty iff `ok` is true.
 */
export function loadPolicy({ cwd = process.cwd(), base = null } = {}) {
  let text;
  let source;

  if (base != null) {
    const result = spawnSync("git", ["show", `${base}:${POLICY_PATH}`], { cwd, encoding: "utf8" });
    if (result.status !== 0) {
      const detail = (result.stderr || result.error?.message || "").trim();
      return {
        ok: false,
        policy: null,
        errors: [`cannot read ${POLICY_PATH} at ${base}${detail ? `: ${detail}` : ""}`],
      };
    }
    text = result.stdout;
    source = `${POLICY_PATH} at ${base}`;
  } else {
    try {
      text = readFileSync(join(cwd, POLICY_PATH), "utf8");
    } catch (err) {
      return {
        ok: false,
        policy: null,
        errors: [`cannot read ${POLICY_PATH} in the working tree: ${err.message}`],
      };
    }
    source = `${POLICY_PATH} (working tree)`;
  }

  let policy;
  try {
    policy = JSON.parse(text);
  } catch (err) {
    return { ok: false, policy: null, errors: [`cannot parse ${source} as JSON: ${err.message}`] };
  }

  const errors = policyViolations(policy).map((e) => `${source}: ${e}`);
  return { ok: errors.length === 0, policy, errors };
}

/**
 * True when the named transition still needs a human at the given track-record
 * level. "human" always needs one; "auto" never; `{ auto_at_level: n }` needs
 * one below level n and is automatic at or above it. An unknown transition id,
 * or a value that is neither form, fails closed and returns true.
 */
export function requiresHuman(policy, transitionId, level = 0) {
  const entry = policy?.autonomy?.[transitionId];
  if (entry === "human") return true;
  if (entry === "auto") return false;
  if (isPlainObject(entry) && Number.isInteger(entry.auto_at_level)) {
    return !(level >= entry.auto_at_level);
  }
  return true;
}

/**
 * True only when every run budget is a positive integer. A null (unset) budget
 * keeps every run attended: an unbounded run must not be run unattended.
 */
export function unattendedAllowed(policy) {
  const budgets = policy?.budgets;
  if (!isPlainObject(budgets)) return false;
  return BUDGET_KEYS.every((key) => Number.isInteger(budgets[key]) && budgets[key] > 0);
}
