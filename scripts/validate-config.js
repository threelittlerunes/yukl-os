#!/usr/bin/env node
// AF-1 / `npm run build`: static integrity validation for the harness.
//
// Validates the machine-readable harness configuration (flow.config.json,
// yukl.config.json, .yukl-intent.yml, every .orchestration/intents/*.yml) and
// delegates the repo-only governance checks (community files, rule routing,
// instruction budgets, AGENTS.md parity) to scripts/repo-checks.js. Exits
// non-zero on any failure.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readJson, readYaml, ROOT, CONTRACT_SCHEMA } from "./lib/harness.js";
import { INTENTS_DIR, taskIntentViolations, yuklConfigViolations } from "./yukl.js";
import {
  ALLOWED_AGENTS,
  PLACEHOLDER_RE,
  validateConsistency,
  validateGithubStandards,
  validateOrcaYaml,
  validateRules,
  validateShippedFiles,
} from "./repo-checks.js";

function isString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

export function validateFlowConfig() {
  const errors = [];
  const raw = readJson("flow.config.json");

  if (!isString(raw.artifactsDir))
    errors.push("flow.config.json: artifactsDir must be a non-empty string");
  if (!Number.isInteger(raw.maxRetries) || raw.maxRetries < 0)
    errors.push("flow.config.json: maxRetries must be a non-negative integer");
  if (typeof raw.autoRun !== "boolean") errors.push("flow.config.json: autoRun must be a boolean");

  const d = raw.defaults;
  if (!d || typeof d !== "object") {
    errors.push("flow.config.json: defaults object is required");
  } else {
    if (typeof d.timeoutMs !== "number")
      errors.push("flow.config.json: defaults.timeoutMs must be a number");
    if (typeof d.readinessMinBytes !== "number")
      errors.push("flow.config.json: defaults.readinessMinBytes must be a number");
    if (!Object.hasOwn(d, "worktree"))
      errors.push("flow.config.json: defaults.worktree must be present");
  }

  if (!Array.isArray(raw.pipeline) || raw.pipeline.length === 0) {
    errors.push("flow.config.json: pipeline must be a non-empty array");
    return { errors, pipeline: [] };
  }

  const ids = new Set(raw.pipeline.map((s) => s?.id).filter(isString));
  raw.pipeline.forEach((stage, i) => {
    const at = `flow.config.json: pipeline[${i}]`;
    if (!isString(stage.id)) errors.push(`${at}.id must be a non-empty string`);
    if (!isString(stage.title)) errors.push(`${at}.title must be a non-empty string`);
    if (typeof stage.enabled !== "boolean") errors.push(`${at}.enabled must be a boolean`);
    if (!isString(stage.agent)) errors.push(`${at}.agent must be a non-empty string`);
    else if (!ALLOWED_AGENTS.includes(stage.agent))
      errors.push(`${at}.agent "${stage.agent}" is not in ${ALLOWED_AGENTS.join(", ")}`);
    if (!isString(stage.spec)) errors.push(`${at}.spec must be a non-empty string`);
    if (!Array.isArray(stage.reads)) errors.push(`${at}.reads must be an array`);
    if (
      Object.hasOwn(stage, "onFailGoto") &&
      stage.onFailGoto !== null &&
      !ids.has(stage.onFailGoto)
    )
      errors.push(`${at}.onFailGoto "${stage.onFailGoto}" does not reference a pipeline stage`);
    if (Object.hasOwn(stage, "gate") && typeof stage.gate !== "boolean")
      errors.push(`${at}.gate must be a boolean when present`);
    if (Object.hasOwn(stage, "interactive") && typeof stage.interactive !== "boolean")
      errors.push(`${at}.interactive must be a boolean when present`);
  });

  const drafter = raw.pipeline.find((s) => s.id === "expert-power-drafter");
  if (!drafter) {
    errors.push("flow.config.json: the expert-power-drafter stage is required");
  } else if (drafter.writes !== CONTRACT_SCHEMA) {
    errors.push(
      `flow.config.json: expert-power-drafter.writes must be "${CONTRACT_SCHEMA}" (AF-7), got "${drafter.writes}"`,
    );
  }

  return { errors, pipeline: raw.pipeline };
}

export function validateIntent() {
  const errors = [];
  const doc = readYaml(".yukl-intent.yml");

  if (!doc || typeof doc !== "object") {
    return { errors: [".yukl-intent.yml: root must be a mapping"] };
  }
  if (!doc.intent || typeof doc.intent !== "object") {
    errors.push(".yukl-intent.yml: intent block is required");
  } else {
    if (!isString(doc.intent.goal))
      errors.push(".yukl-intent.yml: intent.goal must be a non-empty string");
    else if (PLACEHOLDER_RE.test(doc.intent.goal))
      errors.push(".yukl-intent.yml: intent.goal still contains placeholder text (IC-10)");

    const scope = doc.intent.scope;
    if (!scope || !Array.isArray(scope.allowed_paths) || scope.allowed_paths.length === 0)
      errors.push(".yukl-intent.yml: intent.scope.allowed_paths must be a non-empty array");
    else if (!scope.allowed_paths.every((p) => typeof p === "string" && !PLACEHOLDER_RE.test(p)))
      errors.push(".yukl-intent.yml: intent.scope.allowed_paths contains placeholder entries");
  }

  const rp = doc.rational_persuasion;
  if (!rp || !Array.isArray(rp.empirical_proof) || rp.empirical_proof.length === 0) {
    errors.push(".yukl-intent.yml: rational_persuasion.empirical_proof must be a non-empty array");
  } else {
    rp.empirical_proof.forEach((claim, i) => {
      const at = `.yukl-intent.yml: rational_persuasion.empirical_proof[${i}]`;
      if (!isString(claim.command)) errors.push(`${at}.command must be a non-empty string`);
      if (typeof claim.expected_exit_code !== "number")
        errors.push(`${at}.expected_exit_code must be a number`);
    });
  }

  if (!doc.consultation || typeof doc.consultation.requires_human_approval !== "boolean")
    errors.push(".yukl-intent.yml: consultation.requires_human_approval must be a boolean");

  return { errors };
}

/**
 * Validate the repo-wide gate config (yukl.config.json). The shared schema
 * lives in the installable core; this repo additionally requires the
 * build/test/format command shortcuts so the harness can run its own gate.
 */
export function validateYuklConfig() {
  const errors = [];
  const raw = readJson("yukl.config.json");
  errors.push(...yuklConfigViolations(raw).map((e) => `yukl.config.json: ${e}`));
  const commands = raw?.commands ?? {};
  for (const key of ["build", "test", "format"]) {
    if (typeof commands[key] !== "string" || commands[key].trim() === "")
      errors.push(
        `yukl.config.json: commands.${key} must be a non-empty string (repo requirement)`,
      );
  }
  return { errors };
}

/** List the per-task intent files under .orchestration/intents/, sorted. */
export function listIntentFiles() {
  return readdirSync(join(ROOT, INTENTS_DIR))
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => `${INTENTS_DIR}/${f}`);
}

/** Validate every per-task intent file (schema lives in the core). */
export function validateIntents() {
  const errors = [];
  for (const relPath of listIntentFiles()) {
    const doc = readYaml(relPath);
    errors.push(...taskIntentViolations(doc).map((e) => `${relPath}: ${e}`));
  }
  return { errors };
}

export function validateAll() {
  const groups = {
    flowConfig: validateFlowConfig(),
    yuklConfig: validateYuklConfig(),
    intents: validateIntents(),
    intent: validateIntent(),
    rules: validateRules(),
    orca: validateOrcaYaml(),
    consistency: validateConsistency(),
    shipped: validateShippedFiles(),
    github: validateGithubStandards(),
  };
  const errors = Object.entries(groups).flatMap(([name, r]) =>
    r.errors.map((e) => `[${name}] ${e}`),
  );
  return { ok: errors.length === 0, errors, groups };
}

const VALIDATORS_DIR = join(ROOT, "scripts", "validators");

/**
 * Run every validator plugin under `validatorsDir` (default: the repo's
 * scripts/validators/). Only *.js files are loaded, in sorted order; a missing
 * directory, or one holding just a .gitkeep, yields no errors. Each module
 * exports `name` (string) and `validate(root)` returning `{ errors: string[] }`
 * (it may be async); every reported error is prefixed `[plugin:<name>] `, and a
 * module missing `name` or `validate` is itself an error.
 */
export async function validatePlugins({ validatorsDir = VALIDATORS_DIR } = {}) {
  const errors = [];
  if (!existsSync(validatorsDir)) return { ok: true, errors };

  const files = readdirSync(validatorsDir)
    .filter((f) => f.endsWith(".js"))
    .sort();

  for (const file of files) {
    let mod;
    try {
      mod = await import(pathToFileURL(join(validatorsDir, file)).href);
    } catch (err) {
      errors.push(`[plugin:${file}] failed to load: ${err?.message ?? err}`);
      continue;
    }
    if (typeof mod.name !== "string" || mod.name.trim() === "") {
      errors.push(`[plugin:${file}] plugin is missing a "name" export`);
      continue;
    }
    if (typeof mod.validate !== "function") {
      errors.push(`[plugin:${mod.name}] plugin is missing a "validate" export`);
      continue;
    }
    try {
      const result = await mod.validate(ROOT);
      for (const e of result?.errors ?? []) errors.push(`[plugin:${mod.name}] ${e}`);
    } catch (err) {
      errors.push(`[plugin:${mod.name}] threw: ${err?.message ?? err}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

async function main() {
  const { errors: coreErrors } = validateAll();
  const { errors: pluginErrors } = await validatePlugins();
  const errors = [...coreErrors, ...pluginErrors];
  if (errors.length > 0) {
    console.error("Harness config validation FAILED:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }
  console.log("Harness config validation OK.");
}

if (process.argv[1]?.endsWith("validate-config.js")) {
  main().catch((err) => {
    console.error(`validate-config: ${err?.stack ?? err}`);
    process.exitCode = 1;
  });
}
