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

// A whole line `@<path>` is an agent-doc import: Claude Code replaces it with
// the named file, so `CLAUDE.md` can hold the single line `@AGENTS.md`.
const IMPORT_LINE_RE = /^@(\S+)$/;
const MAX_IMPORT_DEPTH = 5;

/**
 * Read a markdown file relative to a repository root with its whole-line
 * `@<path>` imports expanded, so a check sees the text the agent sees. Only a
 * repository-relative path is expanded: an absolute path, a `~` path or one
 * with a `..` segment throws, as does an import of a file that does not exist,
 * an import cycle or nesting deeper than five files. Every other line,
 * including an `@` inside a sentence, is kept byte for byte.
 */
export function readImported(relPath, root = ROOT) {
  const expand = (path, chain) => {
    if (chain.includes(path)) {
      throw new Error(`import cycle: ${[...chain, path].join(" -> ")}`);
    }
    if (chain.length > MAX_IMPORT_DEPTH) {
      throw new Error(`imports nest deeper than ${MAX_IMPORT_DEPTH} files at ${path}`);
    }
    const lines = readText(path, root).split("\n");
    return lines
      .map((line) => {
        const match = IMPORT_LINE_RE.exec(line.replace(/\r$/, ""));
        if (match === null) return line;
        const target = match[1];
        if (
          target.startsWith("/") ||
          target.startsWith("~") ||
          /^[A-Za-z]:/.test(target) ||
          target.split(/[\\/]/).includes("..")
        ) {
          throw new Error(`${path}: import "${target}" must be a repository-relative path`);
        }
        if (!exists(target, root)) {
          throw new Error(`${path}: imported file "${target}" does not exist`);
        }
        return expand(target, [...chain, path]).replace(/\r?\n$/, "");
      })
      .join("\n");
  };
  return expand(relPath, []);
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
