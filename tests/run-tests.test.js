import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTests } from "../scripts/run-tests.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = join(ROOT, "scripts", "run-tests.js");

// A one-test file that always passes, and one that always fails. Written
// into a temp dir so the real tests/ directory is never discovered by a
// spawned runner (which would recurse into this very file).
const PASSING_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";

test("passes", () => {
  assert.equal(1, 1);
});
`;

const FAILING_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";

test("fails", () => {
  assert.equal(1, 2);
});
`;

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-run-tests-"));
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

/** Spawn the runner against `dir` with the real node binary. */
function runRunner(dir) {
  return spawnSync(process.execPath, [RUNNER, dir], {
    encoding: "utf8",
    timeout: 60000,
  });
}

test("discoverTests lists only the top-level *.test.js files, sorted", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "b.test.js"), "// b\n");
    writeFileSync(join(dir, "a.test.js"), "// a\n");
    writeFileSync(join(dir, "helper.js"), "// not a test\n");
    writeFileSync(join(dir, "contract.json"), "{}\n");
    mkdirSync(join(dir, "fixtures"));
    writeFileSync(join(dir, "fixtures", "nested.test.js"), "// nested\n");

    const found = discoverTests(dir);
    assert.deepEqual(
      found.map((p) => basename(p)),
      ["a.test.js", "b.test.js"],
      "only top-level test files, sorted, no subdirectories or fixtures",
    );
    assert.ok(
      found.every((p) => dirname(p) === dir),
      "every discovered path sits directly inside the target directory",
    );
  });
});

test("discoverTests yields nothing for a missing directory", () => {
  assert.deepEqual(discoverTests(join(tmpdir(), "yukl-missing-tests-dir")), []);
});

test("the runner exits 0 on a temp dir with one passing test", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "pass.test.js"), PASSING_TEST);
    const result = runRunner(dir);
    assert.equal(result.status, 0, `expected exit 0:\n${result.stdout}\n${result.stderr}`);
    assert.equal(result.signal, null, "a passing run must not be killed by a signal");
    assert.match(result.stdout, /passes/, "the passing test must have run");
  });
});

test("the runner exits non-zero on a temp dir with one failing test", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "fail.test.js"), FAILING_TEST);
    const result = runRunner(dir);
    assert.notEqual(result.status, 0, `expected a non-zero exit:\n${result.stdout}`);
    assert.match(result.stdout, /fails/, "the failing test must have run");
  });
});

test("the runner never passes a JSON fixture to node --test", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "sample.test.js"), PASSING_TEST);
    writeFileSync(join(dir, "contract.json"), JSON.stringify({ task_id: "not-a-test" }));

    const found = discoverTests(dir);
    assert.deepEqual(
      found.map((p) => basename(p)),
      ["sample.test.js"],
      "the JSON fixture is not a *.test.js file and must be ignored",
    );

    const result = runRunner(dir);
    assert.equal(result.status, 0, `expected exit 0:\n${result.stdout}\n${result.stderr}`);
  });
});
