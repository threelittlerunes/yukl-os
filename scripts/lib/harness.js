#!/usr/bin/env node
// Shared helpers for the Yukl-OS harness tooling.
// Zero runtime dependencies beyond js-yaml (dev-only, used for config validation).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repository root. */
export const ROOT = join(HERE, "..", "..");

export const RULES_DIR = join(ROOT, ".claude", "rules");
export const CONTRACTS_DIR = ".orchestration/contracts";
export const CONTRACT_SCHEMA = `${CONTRACTS_DIR}/<task_id>.json`;
export const CONTRACT_REF_RE = /\.orchestration\/contracts\/[^\s")'`]+/g;

/** Read a UTF-8 text file relative to the repository root. */
export function readText(relPath) {
  return readFileSync(join(ROOT, relPath), "utf8");
}

/** Parse a JSON file relative to the repository root. */
export function readJson(relPath) {
  return JSON.parse(readText(relPath));
}

/** Parse a YAML file relative to the repository root. */
export function readYaml(relPath) {
  return yaml.load(readText(relPath));
}

/** True when a path exists relative to the repository root. */
export function exists(relPath) {
  return existsSync(join(ROOT, relPath));
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
