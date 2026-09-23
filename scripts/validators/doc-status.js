#!/usr/bin/env node
// Opt-in documentation status validator (plugin seam).
//
// A document opts in by placing `<!-- yukl:doc-status -->` on its first line.
// Opted-in documents must annotate every `##` and `###` heading, on the next
// non-empty line, with exactly one status marker: `planned`, `background` or
// `implemented` (the latter naming a real test). Documents without the marker
// are skipped, so the validation lands green while nothing opts in yet.
//
// `scripts/validate-config.js` loads every `scripts/validators/*.js` module and
// calls `validate(root)`; `docStatusViolations` is exported separately so the
// checks can be exercised against plain text in the test suite.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const name = "doc-status";

export const OPT_IN_MARKER = "<!-- yukl:doc-status -->";

const OPT_IN_RE = /^<!--\s*yukl:doc-status\s*-->$/;
const PLAIN_MARKER_RE = /^<!--\s*status:\s*(planned|background)\s*-->$/;
const IMPLEMENTED_RE = /^<!--\s*status:\s*implemented\s+tests=(\S+?)#(.+?)\s*-->$/;
// At most three leading spaces may precede a heading; four or more is an
// indented code block. The match runs on the raw line, before trimming, so an
// indented heading is still a heading but an indented code line is not.
const HEADING_RE = /^ {0,3}(#{2,3})[ \t]+(.+?)[ \t]*$/;
const FENCE_RE = /^(`{3,}|~{3,})/;

function isOptedIn(text) {
  const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  return OPT_IN_RE.test(firstLine.trim());
}

/**
 * Check the implemented marker against the repository it names.
 * `testPath` must be a `tests/<file>` path that exists and whose source holds
 * a `test("<name>")` call (single quotes and backticks are accepted too).
 */
function implementedViolations(testPath, testName, root, label) {
  const errors = [];

  if (!testPath.startsWith("tests/") || testPath.includes("..")) {
    errors.push(`${label}: implemented marker must name a "tests/<file>" path, got "${testPath}"`);
    return errors;
  }

  if (!existsSync(join(root, testPath))) {
    errors.push(`${label}: implemented marker names a missing test file "${testPath}"`);
    return errors;
  }

  const source = readFileSync(join(root, testPath), "utf8");
  const escapedName = testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const callRe = new RegExp(`\\btest\\(\\s*(["'\`])${escapedName}\\1`);
  if (!callRe.test(source)) {
    errors.push(
      `${label}: implemented marker names a test "${testName}" that is absent from ${testPath}`,
    );
  }

  return errors;
}

/**
 * Pure checker: every `##`/`###` heading in an opted-in document must be
 * followed by a status marker. Headings inside fenced code blocks are ignored,
 * and a document without the opt-in marker is skipped entirely. Returns an
 * array of violation strings (empty array = valid).
 */
export function docStatusViolations(text, { root, relPath } = {}) {
  const errors = [];
  if (!isOptedIn(text)) return errors;

  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  let inFence = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.trim().match(FENCE_RE);
    if (fence) {
      const char = fence[1][0];
      if (inFence === null) inFence = char;
      else if (inFence === char) inFence = null;
      continue;
    }
    if (inFence !== null) continue;

    const heading = line.match(HEADING_RE);
    if (!heading) continue;

    const label = `${relPath}:${i + 1}: heading "${heading[1]} ${heading[2]}"`;

    let next = null;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() !== "") {
        next = lines[j].trim();
        break;
      }
    }

    if (next === null) {
      errors.push(`${label} is not followed by a status marker`);
      continue;
    }
    if (PLAIN_MARKER_RE.test(next)) continue;

    const implemented = next.match(IMPLEMENTED_RE);
    if (implemented) {
      errors.push(...implementedViolations(implemented[1], implemented[2], root, label));
      continue;
    }

    errors.push(`${label} is not followed by a status marker (found "${next}")`);
  }

  return errors;
}

/** Recursively collect `*.md` paths under `relDir`, relative to `root`. */
function collectMarkdown(root, relDir, out) {
  const absDir = join(root, relDir);
  if (!existsSync(absDir)) return;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const relPath = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) collectMarkdown(root, relPath, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(relPath);
  }
}

/** The candidate documents: root `*.md` plus `docs/**\/*.md`, sorted. */
function listCandidateDocs(root) {
  const docs = [];
  if (!existsSync(root)) return docs;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) docs.push(entry.name);
  }
  collectMarkdown(root, "docs", docs);
  return docs.sort();
}

/** Plugin seam: validate every candidate document under `root`. */
export function validate(root) {
  const errors = [];
  for (const relPath of listCandidateDocs(root)) {
    const text = readFileSync(join(root, relPath), "utf8");
    errors.push(...docStatusViolations(text, { root, relPath }));
  }
  return { errors };
}
