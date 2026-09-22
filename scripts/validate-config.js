#!/usr/bin/env node
// AF-1 / `npm run build`: static integrity validation for the harness.
//
// Validates the machine-readable harness configuration (flow.config.json,
// .yukl-intent.yml), the path-scoped rule frontmatter, the contract-filename
// standard (AF-7), the single-VCS invariant (AF-6), and the presence of the
// GitHub community-health files. Exits non-zero on any failure.

import {
  listRuleFiles,
  readText,
  readJson,
  readYaml,
  splitFrontmatter,
  exists,
  CONTRACT_SCHEMA,
} from "./lib/harness.js";

export const REQUIRED_FILES = [
  "LICENSE",
  "package.json",
  "biome.json",
  "README.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "CHANGELOG.md",
  ".gitignore",
  ".gitattributes",
  "flow.config.json",
  "orca.yaml",
  ".yukl-intent.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
  ".orchestration/contracts/.gitkeep",
  ".orchestration/locks/.gitkeep",
  ".orchestration/artifacts/.gitkeep",
  ".orchestration/artifacts/README.md",
  ".claude/rules/drafter-ui.md",
  "scripts/count-instructions.js",
  "scripts/validate-config.js",
];

export const SCAN_FILES = [
  "CLAUDE.md",
  "README.md",
  "flow.config.json",
  "orca.yaml",
  ".yukl-intent.yml",
  "docs/YUKL_ARCHITECTURE.md",
  "docs/SDLC_PLAN.md",
  ...listRuleFiles(),
];

const ALLOWED_AGENTS = ["claude", "opencode", "codex", "gemini", "antigravity"];
const PLACEHOLDER_RE =
  /Briefly describe|Replace this|\[Replace|\[e\.g\.|Assumption 1\.\.\.|Assumption 2\.\.\.|feature-name/i;
const ANGLE_PLACEHOLDER_RE = /<your-[a-z-]+>/i;

export const SHIPPED_FILES = ["INTENT.md", "CONTRIBUTING.md"];

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

export function validateRules() {
  const errors = [];
  for (const file of listRuleFiles()) {
    const { frontmatter, hasFrontmatter } = splitFrontmatter(readText(file));
    if (!hasFrontmatter) {
      errors.push(`${file}: path-scoped rules must declare YAML frontmatter (IC-8)`);
      continue;
    }
    if (!Array.isArray(frontmatter.paths) || frontmatter.paths.length === 0) {
      errors.push(`${file}: frontmatter must declare a non-empty "paths" array`);
      continue;
    }
    if (!frontmatter.paths.every((p) => typeof p === "string" && p.length > 0))
      errors.push(`${file}: every frontmatter path must be a non-empty string`);
  }

  const auditor = readText(".claude/rules/auditor.md");
  const auditorFm = splitFrontmatter(auditor).frontmatter ?? {};
  if ((auditorFm.paths ?? []).some((p) => p.startsWith("src/")))
    errors.push(".claude/rules/auditor.md: must not grant a src/** write scope (AF-10)");

  const ui = readText(".claude/rules/drafter-ui.md");
  const uiPaths = splitFrontmatter(ui).frontmatter?.paths ?? [];
  if (!uiPaths.includes("src/ui/**"))
    errors.push('.claude/rules/drafter-ui.md: frontmatter paths must include "src/ui/**" (IC-1)');

  const routed = new Set(
    readText("CLAUDE.md").match(/\.claude\/rules\/[A-Za-z0-9._-]+\.md/g) ?? [],
  );
  for (const file of listRuleFiles()) {
    if (!routed.has(file))
      errors.push(`CLAUDE.md: section 2 routing table does not reference ${file} (V-1)`);
  }

  return { errors };
}

export function validateOrcaYaml() {
  const errors = [];
  const doc = readYaml("orca.yaml");

  if (!doc || typeof doc !== "object") {
    return { errors: ["orca.yaml: root must be a mapping"] };
  }

  const listed = new Set();
  const agents = doc.agents;
  if (agents === undefined || agents === null || typeof agents !== "object") {
    errors.push("orca.yaml: agents block must be a mapping");
  } else {
    for (const [name, agent] of Object.entries(agents)) {
      if (!agent || typeof agent !== "object") {
        errors.push(`orca.yaml: agents.${name} must be a mapping`);
        continue;
      }
      if (Array.isArray(agent.rules)) {
        for (const rule of agent.rules) if (typeof rule === "string") listed.add(rule);
      }
      if (!isString(agent.agent))
        errors.push(`orca.yaml: agents.${name}.agent must be a non-empty string`);
      else if (!ALLOWED_AGENTS.includes(agent.agent))
        errors.push(
          `orca.yaml: agents.${name}.agent "${agent.agent}" is not in ${ALLOWED_AGENTS.join(", ")}`,
        );
    }
  }

  for (const file of listRuleFiles()) {
    if (!listed.has(file))
      errors.push(`orca.yaml: ${file} is not listed in any agents.*.rules array (V-2)`);
  }

  const pipeline = doc.pipeline;
  if (!pipeline || typeof pipeline !== "object") {
    errors.push("orca.yaml: pipeline block must be a mapping");
  } else {
    const flow = readJson("flow.config.json");
    if (pipeline.config !== "flow.config.json")
      errors.push('orca.yaml: pipeline.config must be "flow.config.json"');
    if (pipeline.artifactsDir !== flow.artifactsDir)
      errors.push(
        `orca.yaml: pipeline.artifactsDir must match flow.config.json artifactsDir ("${flow.artifactsDir}")`,
      );
  }

  if (!doc.contracts || doc.contracts.schema !== CONTRACT_SCHEMA)
    errors.push(`orca.yaml: contracts.schema must match "${CONTRACT_SCHEMA}" (AF-7)`);

  const env = doc.environment;
  if (!env || typeof env !== "object") {
    errors.push("orca.yaml: environment block must be a mapping");
  } else {
    if (!isString(env.worktree?.root))
      errors.push("orca.yaml: environment.worktree.root must be a non-empty string");
    if (!isString(env.locks?.dir))
      errors.push("orca.yaml: environment.locks.dir must be a non-empty string");
  }

  return { errors };
}

export function validateShippedFiles() {
  const errors = [];
  for (const file of SHIPPED_FILES) {
    const text = readText(file);
    if (PLACEHOLDER_RE.test(text))
      errors.push(`${file}: still contains template placeholder text (V-4)`);
    if (ANGLE_PLACEHOLDER_RE.test(text))
      errors.push(`${file}: still contains an angle-bracket placeholder (V-4)`);
  }
  return { errors };
}

export function validateConsistency() {
  const errors = [];
  for (const file of SCAN_FILES) {
    const text = readText(file);

    if (/\bjj\b/i.test(text) || /Jujutsu/i.test(text)) {
      errors.push(
        `${file}: references Jujutsu/jj; the harness standardises on Git worktrees (AF-6)`,
      );
    }
    if (/\bCONTRACT\.json\b/.test(text)) {
      errors.push(`${file}: references CONTRACT.json; use ${CONTRACT_SCHEMA} (AF-7)`);
    }
    if (/current_task\.json/.test(text) && file !== ".orchestration/artifacts/README.md") {
      errors.push(`${file}: references current_task.json; use ${CONTRACT_SCHEMA} (AF-7)`);
    }
    for (const ref of text.match(/\.orchestration\/contracts\/[^\s"')`]+/g) ?? []) {
      const ok =
        /^\.orchestration\/contracts\/(<task_id>|\{task_id\})\.json$/.test(ref) ||
        /^\.orchestration\/contracts\/\*\.json$/.test(ref);
      if (!ok)
        errors.push(
          `${file}: contract reference "${ref}" does not follow ${CONTRACT_SCHEMA} (AF-7)`,
        );
    }
    if (/Ecological Power/i.test(text)) {
      errors.push(`${file}: references the non-standard term "Ecological Power" (AF-5)`);
    }
  }
  return { errors };
}

export function validateGithubStandards() {
  const errors = [];
  for (const file of REQUIRED_FILES) {
    if (!exists(file)) errors.push(`Missing required file: ${file} (AF-2/AF-3/GitHub standards)`);
  }
  if (exists("README.md")) {
    const readme = readText("README.md");
    if (!readme.includes("img.shields.io")) errors.push("README.md: missing status badges");
    if (!readme.includes("LICENSE")) errors.push("README.md: missing a licence badge/section");
  }
  if (exists("LICENSE") && !readText("LICENSE").includes("MIT License"))
    errors.push("LICENSE: expected an MIT licence (AF-3)");
  return { errors };
}

export function validateAll() {
  const groups = {
    flowConfig: validateFlowConfig(),
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

function main() {
  const { ok, errors } = validateAll();
  if (!ok) {
    console.error("Harness config validation FAILED:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }
  console.log("Harness config validation OK.");
}

if (process.argv[1]?.endsWith("validate-config.js")) {
  main();
}
