import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { docStatusViolations, name, validate } from "../scripts/validators/doc-status.js";
import { countInstructions } from "../scripts/repo-checks.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "tests", "fixtures", "doc-status");

function fixture(name) {
  return readFileSync(join(FIXTURES, name), "utf8");
}

// Build an opted-in copy of a document: the opt-in marker on the first line
// plus a `planned` status marker after every `##`/`###` heading. Used to prove
// that the status markers are invisible to the instruction count.
function annotateWithMarkers(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = ["<!-- yukl:doc-status -->"];
  for (const line of lines) {
    out.push(line);
    if (/^ {0,3}#{2,3}[ \t]/.test(line)) out.push("<!-- status: planned -->");
  }
  return out.join("\n");
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-doc-status-"));
  try {
    return await fn(dir);
  } finally {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (err.code !== "EPERM" && err.code !== "EBUSY") throw err;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
    }
  }
}

test("the doc-status plugin declares its name", () => {
  assert.equal(name, "doc-status");
});

test("docStatusViolations skips a document without the opt-in marker", () => {
  const text = ["# Title", "", "## Unmarked section", "", "Body text."].join("\n");
  assert.deepEqual(docStatusViolations(text, { root: ROOT, relPath: "skipped.md" }), []);
});

test("docStatusViolations rejects an opted-in document with an unmarked section", () => {
  const text = [
    "<!-- yukl:doc-status -->",
    "",
    "# Title",
    "",
    "## No marker here",
    "",
    "Body text.",
  ].join("\n");
  const errors = docStatusViolations(text, { root: ROOT, relPath: "bad.md" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^bad\.md:5: heading "## No marker here"/);
  assert.match(errors[0], /is not followed by a status marker/);
});

test("the unmarked-section fixture is rejected", () => {
  const errors = docStatusViolations(fixture("unmarked-section.md"), {
    root: ROOT,
    relPath: "unmarked-section.md",
  });
  assert.equal(errors.length, 2);
  assert.ok(errors.every((e) => /is not followed by a status marker/.test(e)));
});

test("the missing-test fixture is rejected", () => {
  const errors = docStatusViolations(fixture("missing-test.md"), {
    root: ROOT,
    relPath: "missing-test.md",
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /names a missing test file "tests\/does-not-exist\.test\.js"/);
});

test("the all-markers control fixture passes", () => {
  const errors = docStatusViolations(fixture("all-markers.md"), {
    root: ROOT,
    relPath: "all-markers.md",
  });
  assert.deepEqual(errors, []);
});

test("docStatusViolations ignores headings inside fenced code blocks", () => {
  const text = [
    "<!-- yukl:doc-status -->",
    "",
    "# Title",
    "",
    "```md",
    "## Not a real heading",
    "",
    "### Neither is this",
    "```",
    "",
    "## A real heading",
    "",
    "<!-- status: planned -->",
  ].join("\n");
  assert.deepEqual(docStatusViolations(text, { root: ROOT, relPath: "fenced.md" }), []);
});

test("docStatusViolations ignores headings inside tilde fences", () => {
  const text = [
    "<!-- yukl:doc-status -->",
    "",
    "# Title",
    "",
    "~~~md",
    "## Not a real heading",
    "",
    "### Neither is this",
    "~~~",
    "",
    "## A real heading",
    "",
    "<!-- status: planned -->",
  ].join("\n");
  assert.deepEqual(docStatusViolations(text, { root: ROOT, relPath: "tilde.md" }), []);
});

test("headings may be indented by up to three spaces, but four is code", () => {
  const heading = (indent) =>
    [
      "<!-- yukl:doc-status -->",
      "",
      "# Title",
      "",
      `${" ".repeat(indent)}## Indented heading`,
      "",
      "<!-- status: planned -->",
    ].join("\n");

  assert.deepEqual(docStatusViolations(heading(3), { root: ROOT, relPath: "three.md" }), []);

  const indentedCode = [
    "<!-- yukl:doc-status -->",
    "",
    "# Title",
    "",
    "    ## Four spaces is an indented code block",
    "",
    "Body text.",
  ].join("\n");
  assert.deepEqual(docStatusViolations(indentedCode, { root: ROOT, relPath: "four.md" }), []);
});

test("implemented markers accept single-quoted and backtick test names", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(
      join(dir, "tests", "sample.test.js"),
      [
        'test("double quoted case", () => {});',
        "test('single quoted case', () => {});",
        "test(`backtick case`, () => {});",
      ].join("\n"),
    );
    const text = [
      "<!-- yukl:doc-status -->",
      "",
      "## Double",
      "",
      "<!-- status: implemented tests=tests/sample.test.js#double quoted case -->",
      "",
      "## Single",
      "",
      "<!-- status: implemented tests=tests/sample.test.js#single quoted case -->",
      "",
      "## Backtick",
      "",
      "<!-- status: implemented tests=tests/sample.test.js#backtick case -->",
    ].join("\n");
    const errors = docStatusViolations(text, { root: dir, relPath: "quotes.md" });
    assert.deepEqual(errors, []);
  });
});

test("implemented markers reject a test name absent from the named file", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests", "sample.test.js"), 'test("present case", () => {});\n');
    const text = [
      "<!-- yukl:doc-status -->",
      "",
      "## A section",
      "",
      "<!-- status: implemented tests=tests/sample.test.js#absent case -->",
    ].join("\n");
    const errors = docStatusViolations(text, { root: dir, relPath: "absent.md" });
    assert.equal(errors.length, 1);
    assert.match(
      errors[0],
      /names a test "absent case" that is absent from tests\/sample\.test\.js/,
    );
  });
});

test("validate flags opted-in root and docs files and skips the rest", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(
      join(dir, "A.md"),
      ["<!-- yukl:doc-status -->", "", "## Unmarked", "", "Body."].join("\n"),
    );
    writeFileSync(join(dir, "B.md"), ["# No opt-in", "", "## Unmarked", "", "Body."].join("\n"));
    writeFileSync(
      join(dir, "docs", "C.md"),
      ["<!-- yukl:doc-status -->", "", "## Unmarked", "", "Body."].join("\n"),
    );

    const { errors } = validate(dir);
    assert.equal(errors.length, 2);
    assert.ok(errors.some((e) => e.startsWith("A.md:")));
    assert.ok(errors.some((e) => e.startsWith("docs/C.md:")));
    assert.ok(!errors.some((e) => e.startsWith("B.md:")));
  });
});

test("the working tree carries no opted-in documents and validates clean", () => {
  assert.deepEqual(validate(ROOT).errors, []);
});

test("status markers do not change the instruction count of the real CLAUDE.md", () => {
  const original = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
  const annotated = annotateWithMarkers(original);

  assert.ok(annotated.startsWith("<!-- yukl:doc-status -->"));
  assert.deepEqual(docStatusViolations(annotated, { root: ROOT, relPath: "CLAUDE.md" }), []);
  assert.equal(countInstructions(annotated), countInstructions(original));
});
