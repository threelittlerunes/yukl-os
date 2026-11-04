import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VERDICTS_DIR,
  parseVerdict,
  readVerdictAt,
  verdictPath,
  verdictViolation,
} from "../scripts/lifecycle/verdict.js";

const TASK = "task-verdict";

function git(args, cwd) {
  const result = spawnSync("git", ["-c", "user.name=Yukl Test", "-c", "user.email=", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A temporary repository; `commitVerdict` commits the verdict text and returns the sha. */
function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-verdict-"));
  try {
    git(["init", "-q"], dir);
    writeFileSync(join(dir, "README.md"), "seed\n");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "seed"], dir);
    const commitVerdict = (text) => {
      mkdirSync(join(dir, VERDICTS_DIR), { recursive: true });
      writeFileSync(join(dir, VERDICTS_DIR, `${TASK}.json`), text);
      git(["add", "-A"], dir);
      git(["commit", "-q", "-m", "verdict"], dir);
      return git(["rev-parse", "HEAD"], dir);
    };
    return fn(dir, commitVerdict);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("verdictPath names the task's file under .orchestration/verdicts and refuses unsafe ids", () => {
  assert.equal(verdictPath("task-1"), ".orchestration/verdicts/task-1.json");
  for (const bad of ["", "../x", "a/b", "a..b", "-flag", null, 7]) {
    assert.equal(verdictPath(bad), null, `${String(bad)} must be refused`);
  }
});

test("verdictViolation accepts exactly a pass or fail verdict with string reasons", () => {
  assert.deepEqual(verdictViolation({ verdict: "pass", reasons: [] }), {
    ok: true,
    verdict: "pass",
    reasons: [],
  });
  assert.deepEqual(verdictViolation({ verdict: "fail", reasons: ["proof exited 1"] }), {
    ok: true,
    verdict: "fail",
    reasons: ["proof exited 1"],
  });
});

test("verdictViolation refuses every other shape as malformed", () => {
  const malformed = [
    null,
    [],
    "pass",
    {},
    { verdict: "PASS", reasons: [] },
    { verdict: "Fail", reasons: [] },
    { verdict: "approved", reasons: [] },
    { verdict: "pass" },
    { verdict: "pass", reasons: "fine" },
    { verdict: "pass", reasons: [1] },
    { verdict: "pass", reasons: [], extra: true },
  ];
  for (const doc of malformed) {
    assert.equal(verdictViolation(doc).ok, false, `${JSON.stringify(doc)} must be malformed`);
  }
});

test("parseVerdict refuses text that is not JSON", () => {
  const parsed = parseVerdict("FAIL");
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /cannot parse the verdict as JSON/);
});

test("readVerdictAt reads the committed verdict at the named commit", () => {
  withRepo((dir, commitVerdict) => {
    const sha = commitVerdict(JSON.stringify({ verdict: "fail", reasons: ["R-1"] }));
    const read = readVerdictAt({ cwd: dir, taskId: TASK, commit: sha });
    assert.deepEqual(read, {
      ok: true,
      verdict: "fail",
      reasons: ["R-1"],
      path: `${VERDICTS_DIR}/${TASK}.json`,
      commit: sha,
    });
  });
});

test("readVerdictAt reads the commit, never the working tree", () => {
  withRepo((dir, commitVerdict) => {
    const sha = commitVerdict(JSON.stringify({ verdict: "fail", reasons: [] }));
    writeFileSync(
      join(dir, VERDICTS_DIR, `${TASK}.json`),
      JSON.stringify({ verdict: "pass", reasons: [] }),
    );
    assert.equal(readVerdictAt({ cwd: dir, taskId: TASK, commit: sha }).verdict, "fail");
  });
});

test("readVerdictAt reports a verdict missing at the commit as not ok", () => {
  withRepo((dir) => {
    const head = git(["rev-parse", "HEAD"], dir);
    const read = readVerdictAt({ cwd: dir, taskId: TASK, commit: head });
    assert.equal(read.ok, false);
    assert.match(read.error, /no verdict/);
  });
});

test("readVerdictAt reports a malformed committed verdict as not ok", () => {
  withRepo((dir, commitVerdict) => {
    const sha = commitVerdict(JSON.stringify({ verdict: "PASS", reasons: [] }));
    assert.equal(readVerdictAt({ cwd: dir, taskId: TASK, commit: sha }).ok, false);
  });
});

test("readVerdictAt refuses an anchor that names no commit before running git", () => {
  for (const commit of [undefined, "", "HEAD", "--output=x", "a".repeat(39)]) {
    const read = readVerdictAt({ cwd: tmpdir(), taskId: TASK, commit });
    assert.equal(read.ok, false);
    assert.match(read.error, /names no commit/);
  }
});
