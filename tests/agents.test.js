import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readImported, readText, readJson, exists } from "../scripts/lib/harness.js";
import { agentsParity } from "../scripts/repo-checks.js";

test("AGENTS.md exists for non-Claude agents", () => {
  assert.ok(exists("AGENTS.md"), "AGENTS.md is required at the repository root");
});

test("AGENTS.md body is byte-identical to CLAUDE.md after the title line", () => {
  assert.ok(agentsParity(), "AGENTS.md must mirror CLAUDE.md after the title line");
});

test("package.json is marked private while yukl-os is unclaimed on npm", () => {
  assert.equal(readJson("package.json").private, true);
});

test("package.json version matches the newest released CHANGELOG.md heading", () => {
  const released = readText("CHANGELOG.md").match(/^## \[(\d+\.\d+\.\d+)\]/m);
  assert.ok(released, "CHANGELOG.md must contain a released version heading");
  assert.equal(readJson("package.json").version, released[1]);
});

// ---------------------------------------------------------------------------
// readImported: CLAUDE.md may be the single import line `@AGENTS.md`
// ---------------------------------------------------------------------------

function withRepo(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-import-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readImported expands a whole-line @import to the imported file byte for byte", () => {
  withRepo({ "CLAUDE.md": "@AGENTS.md\n", "AGENTS.md": "# Title\n\nBody line.\n" }, (dir) => {
    assert.equal(readImported("CLAUDE.md", dir), "# Title\n\nBody line.\n");
  });
});

test("readImported keeps an @ inside a sentence and a file without imports unchanged", () => {
  const text = "# Rules\n\nMail @someone about it.\n";
  withRepo({ "CLAUDE.md": text }, (dir) => {
    assert.equal(readImported("CLAUDE.md", dir), text);
  });
});

test("readImported refuses an import that leaves the repository", () => {
  for (const target of ["../x.md", "/x.md", "~x.md", "C:/x.md", "docs/../../x.md"]) {
    withRepo({ "CLAUDE.md": `@${target}\n` }, (dir) => {
      assert.throws(() => readImported("CLAUDE.md", dir), /repository-relative path/);
    });
  }
});

test("readImported refuses a missing import and an import cycle", () => {
  withRepo({ "CLAUDE.md": "@AGENTS.md\n" }, (dir) => {
    assert.throws(() => readImported("CLAUDE.md", dir), /does not exist/);
  });
  withRepo({ "CLAUDE.md": "@AGENTS.md\n", "AGENTS.md": "@CLAUDE.md\n" }, (dir) => {
    assert.throws(() => readImported("CLAUDE.md", dir), /import cycle/);
  });
});

test("the committed CLAUDE.md resolves to exactly the committed AGENTS.md", () => {
  assert.equal(readImported("CLAUDE.md"), readText("AGENTS.md"));
});
