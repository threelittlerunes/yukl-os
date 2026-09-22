#!/usr/bin/env node
// Shared helpers for the Yukl-OS harness tooling.
// Zero runtime dependencies beyond js-yaml (dev-only, used for config validation).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the repository root. Repo-only tooling (config validation,
 * instruction budgets, tests) may rely on this default; the installable core
 * (scripts/yukl.js) must not - it resolves the target repository from
 * process.cwd() or --cwd.
 */
export const ROOT = join(HERE, "..", "..");

export const RULES_DIR = join(ROOT, ".claude", "rules");
export const CONTRACTS_DIR = ".orchestration/contracts";
export const CONTRACT_SCHEMA = `${CONTRACTS_DIR}/<task_id>.json`;

/**
 * Read a UTF-8 text file relative to a repository root.
 * `root` defaults to the package root; core consumers pass the target
 * repository's root explicitly.
 */
export function readText(relPath, root = ROOT) {
  return readFileSync(join(root, relPath), "utf8");
}

/** Parse a JSON file relative to a repository root (see readText). */
export function readJson(relPath, root = ROOT) {
  return JSON.parse(readText(relPath, root));
}

/** Parse a YAML file relative to a repository root (see readText). */
export function readYaml(relPath, root = ROOT) {
  return yaml.load(readText(relPath, root));
}

/** True when a path exists relative to a repository root (see readText). */
export function exists(relPath, root = ROOT) {
  return existsSync(join(root, relPath));
}

/** All markdown files under .claude/rules/, sorted by name. */
export function listRuleFiles() {
  return readdirSync(RULES_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => `.claude/rules/${f}`);
}

/**
 * Split a markdown document into YAML frontmatter and body.
 * Returns { frontmatter: object|null, body: string, hasFrontmatter: boolean }.
 */
export function splitFrontmatter(text) {
  const match = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: null, body: text, hasFrontmatter: false };
  }
  return {
    frontmatter: yaml.load(match[1]) ?? {},
    body: text.slice(match[0].length),
    hasFrontmatter: true,
  };
}
