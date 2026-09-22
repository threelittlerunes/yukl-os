#!/usr/bin/env node
// Repo-only governance checks for the yukl-os repository itself.
//
// Everything in this module governs this repository only: community-health
// files, the path-scoped rule routing (CLAUDE.md section 2, orca.yaml V-2),
// the CLAUDE.md/AGENTS.md parity rule and the instruction budgets. None of it
// ships as part of the installable core (scripts/yukl.js), which must run
// inside any target repository. Only this repo's `npm run build` and
// `npm run test` call this module.

import {
  exists,
  listRuleFiles,
  readText,
  readJson,
  readYaml,
  splitFrontmatter,
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

export const ALLOWED_AGENTS = ["claude", "opencode", "codex", "gemini", "antigravity"];

export const PLACEHOLDER_RE =
  /Briefly describe|Replace this|\[Replace|\[e\.g\.|Assumption 1\.\.\.|Assumption 2\.\.\.|feature-name/i;

export const ANGLE_PLACEHOLDER_RE = /<your-[a-z-]+>/i;

export const SHIPPED_FILES = ["INTENT.md", "CONTRIBUTING.md"];

// ---------------------------------------------------------------------------
// AF-4: instruction budgets (CLAUDE.md and the path-scoped rule files)
// ---------------------------------------------------------------------------

/**
 * Per-file budgets. `maxInstructions` caps the directive count; `maxLines`
 * (optional) caps raw line count - the root constitution is capped at 60 lines
 * by YUKL_ARCHITECTURE.md section 2.4.
 */
export const BUDGETS = {
  "CLAUDE.md": { maxLines: 60, maxInstructions: 40 },
  __total__: { maxInstructions: 150 },
  __default__: { maxInstructions: 30 },
};

/**
 * Count instructions (directives) in a markdown document.
 *
 * An instruction is a sentence-sized directive. Headings, blank lines, fenced
 * code blocks and HTML/YAML comments are ignored. List markers are stripped
 * before sentence splitting, so a one-line bullet is exactly one instruction
 * and a bullet holding three sentences is three.
 */
export function countInstructions(text) {
  const { body } = splitFrontmatter(text);
  let count = 0;
  let inFence = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line === "") continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("<!--") || line.startsWith("//")) continue;

    const content = line.replace(/^(?:[-*+]|\d+\.)\s+/, "").trim();
    if (content === "") continue;

    const sentences = content
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    count += Math.max(1, sentences.length);
  }

  return count;
}

/** Measure every budgeted file and return the rows plus any violations. */
export function measure() {
  const files = ["CLAUDE.md", ...listRuleFiles()];
  const rows = [];
  const violations = [];
  let total = 0;

  for (const file of files) {
    const text = readText(file);
    const instructions = countInstructions(text);
    const lines = text.split(/\r?\n/).length;
    const budget = BUDGETS[file] ?? BUDGETS.__default__;

    total += instructions;
    rows.push({ file, lines, instructions, budget });

    if (budget.maxLines !== undefined && lines > budget.maxLines) {
      violations.push(`${file}: ${lines} lines exceeds the ${budget.maxLines}-line cap`);
    }
    if (instructions > budget.maxInstructions) {
      violations.push(
        `${file}: ${instructions} instructions exceeds the ${budget.maxInstructions}-instruction budget`,
      );
    }
  }

  if (total > BUDGETS.__total__.maxInstructions) {
    violations.push(
      `Total: ${total} instructions exceeds the ${BUDGETS.__total__.maxInstructions}-instruction system budget`,
    );
  }

  return { rows, total, violations };
}

// ---------------------------------------------------------------------------
// CLAUDE.md / AGENTS.md parity
// ---------------------------------------------------------------------------

/** True when AGENTS.md is byte-identical to CLAUDE.md after the title line. */
export function agentsParity() {
  const bodyWithoutTitle = (relPath) =>
    readText(relPath).replace(/\r\n/g, "\n").split("\n").slice(1).join("\n");
  return bodyWithoutTitle("AGENTS.md") === bodyWithoutTitle("CLAUDE.md");
}

// ---------------------------------------------------------------------------
// Community-health and consistency checks
// ---------------------------------------------------------------------------

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

export function validateConsistency() {
  const errors = [];
  for (const file of SCAN_FILES) {
    const text = readText(file);

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

function isString(v) {
  return typeof v === "string" && v.trim().length > 0;
}
