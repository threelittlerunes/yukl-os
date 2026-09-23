#!/usr/bin/env node
// Test discovery for this repository (v2-w0).
//
// The tests/ directory is flat, but pointing `node --test` at a directory
// also picks up JSON fixtures and any nested helper files. This runner
// narrows the input to the top-level *.test.js files, hands them to
// `node --test` in a stable sorted order, and propagates the child's exit
// status so a failing test still fails `npm run test`.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = join(HERE, "..", "tests");

/**
 * The sorted absolute paths of the *.test.js files directly inside `dir`.
 * Subdirectories, fixtures and every other extension are ignored, so only
 * real test files are ever handed to the child process. A missing directory
 * yields an empty list rather than throwing.
 */
export function discoverTests(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".test.js"))
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => join(dir, name));
}

function main() {
  const dir = process.argv[2] || process.env.YUKL_TEST_DIR || DEFAULT_DIR;
  const files = discoverTests(dir);

  if (files.length === 0) {
    console.error(`No *.test.js files found directly in ${dir}.`);
    process.exitCode = 1;
    return;
  }

  // When this runner is itself spawned by `node --test`, the test runner
  // exports NODE_TEST_CONTEXT so its children stay in the same run. A fresh
  // `node --test` inheriting it would refuse to start, so drop it.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  const result = spawnSync(process.execPath, ["--test", ...files], {
    stdio: "inherit",
    env,
  });

  if (result.signal) {
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}

if (process.argv[1]?.endsWith("run-tests.js")) {
  main();
}
