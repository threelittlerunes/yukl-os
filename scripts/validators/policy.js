#!/usr/bin/env node
// Validator plugin: the autonomy policy.
//
// Loaded by scripts/validate-config.js from scripts/validators/*.js. Beyond the
// loader's own schema checks, a policy that grants autonomy above its own
// ceiling is refused here: the ceiling is the hard bound, so an `auto_at_level`
// beyond it would silently outrank it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POLICY_PATH, policyViolations } from "../lifecycle/policy.js";

export const name = "policy";

export function validate(root) {
  let text;
  try {
    text = readFileSync(join(root, POLICY_PATH), "utf8");
  } catch (err) {
    return { errors: [`${POLICY_PATH} cannot be read: ${err.message}`] };
  }

  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { errors: [`${POLICY_PATH} cannot be parsed as JSON: ${err.message}`] };
  }

  const errors = policyViolations(doc);

  const { ceiling, autonomy } = doc ?? {};
  if (Number.isInteger(ceiling) && ceiling >= 0 && autonomy && typeof autonomy === "object") {
    for (const [id, entry] of Object.entries(autonomy)) {
      if (
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Number.isInteger(entry.auto_at_level) &&
        entry.auto_at_level > ceiling
      ) {
        errors.push(
          `autonomy.${id}.auto_at_level ${entry.auto_at_level} is above ceiling ${ceiling}`,
        );
      }
    }
  }

  return { errors };
}
