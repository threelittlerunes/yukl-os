import { test } from "node:test";
import assert from "node:assert/strict";
import { readText, readJson, exists } from "../scripts/lib/harness.js";

function bodyWithoutTitle(relPath) {
  return readText(relPath).replace(/\r\n/g, "\n").split("\n").slice(1).join("\n");
}

test("AGENTS.md exists for non-Claude agents", () => {
  assert.ok(exists("AGENTS.md"), "AGENTS.md is required at the repository root");
});

test("AGENTS.md body is byte-identical to CLAUDE.md after the title line", () => {
  assert.equal(bodyWithoutTitle("AGENTS.md"), bodyWithoutTitle("CLAUDE.md"));
});

test("package.json is marked private while yukl-os is unclaimed on npm", () => {
  assert.equal(readJson("package.json").private, true);
});

test("package.json version matches the newest released CHANGELOG.md heading", () => {
  const released = readText("CHANGELOG.md").match(/^## \[(\d+\.\d+\.\d+)\]/m);
  assert.ok(released, "CHANGELOG.md must contain a released version heading");
  assert.equal(readJson("package.json").version, released[1]);
});
