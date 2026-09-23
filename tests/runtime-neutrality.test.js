import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const LIFECYCLE_DIR = join(ROOT, "scripts", "lifecycle");
const FIXTURES_DIR = join(HERE, "fixtures", "neutrality");

// A static import declaration, an import() call or a require() call whose
// argument is a string literal. The sanctioned adapter route builds its
// argument at run time (`import(pathToFileURL(join(dir, name)).href)`), so it
// never matches and needs no file-name exception.
const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

function listJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listJsFiles(abs));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(abs);
  }
  return files.sort();
}

/** True when a module specifier names a specific adapter file. */
export function namesAdapterFile(specifier) {
  const normalized = String(specifier).replace(/\\/g, "/");
  return /(?:^|\/)adapters\/[^/]+$/.test(normalized);
}

/**
 * Report every runtime-neutrality violation under `dir`: a file that mentions
 * the forbidden agent name, or that statically imports a bundled adapter from
 * scripts/adapters/. Returns an array of human-readable strings (empty = the
 * directory is neutral). Pure over the filesystem, so a test can point it at a
 * fixture directory as well as at scripts/lifecycle/.
 */
export function runtimeNeutralityViolations(dir) {
  const violations = [];
  for (const file of listJsFiles(dir)) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const text = readFileSync(file, "utf8");
    if (/orca/i.test(text)) {
      violations.push(`${rel}: mentions the forbidden runtime name`);
    }
    for (const match of text.matchAll(IMPORT_RE)) {
      if (namesAdapterFile(match[1])) {
        violations.push(`${rel}: imports a bundled adapter via "${match[1]}"`);
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// control: the real lifecycle directory
// ---------------------------------------------------------------------------

test("the lifecycle directory is runtime-neutral", () => {
  assert.deepEqual(runtimeNeutralityViolations(LIFECYCLE_DIR), []);
});

// ---------------------------------------------------------------------------
// must-reject: fixtures that break each clause
// ---------------------------------------------------------------------------

test("the check reports a fixture that spawns the forbidden runner", () => {
  const violations = runtimeNeutralityViolations(FIXTURES_DIR);
  assert.ok(
    violations.some((v) => v.includes("bad-core.js")),
    `expected a violation for bad-core.js, got ${JSON.stringify(violations)}`,
  );
});

test("the check reports a fixture that statically imports a bundled adapter", () => {
  const violations = runtimeNeutralityViolations(FIXTURES_DIR);
  assert.ok(
    violations.some((v) => v.includes("bad-adapter-import.js")),
    `expected a violation for bad-adapter-import.js, got ${JSON.stringify(violations)}`,
  );
});

// ---------------------------------------------------------------------------
// exactness: a clean fixture and the sanctioned route are not flagged
// ---------------------------------------------------------------------------

test("the check leaves a clean fixture and the run-time adapter route alone", () => {
  const violations = runtimeNeutralityViolations(FIXTURES_DIR);
  assert.ok(
    !violations.some((v) => v.includes("good-core.js")),
    `good-core.js must not be flagged, got ${JSON.stringify(violations)}`,
  );
});

test("namesAdapterFile matches adapter files and ignores other specifiers", () => {
  for (const specifier of [
    "../adapters/fake.js",
    "./adapters/fake",
    "scripts/adapters/fake.js",
    "adapters/fake.js",
  ]) {
    assert.equal(namesAdapterFile(specifier), true, specifier);
  }
  for (const specifier of ["../lifecycle/runtime.js", "node:path", "../adapters", "adapters"]) {
    assert.equal(namesAdapterFile(specifier), false, specifier);
  }
});
