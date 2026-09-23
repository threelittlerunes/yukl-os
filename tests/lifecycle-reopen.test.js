import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { R_REOPEN, reopen, reopenedStageComplete } from "../scripts/lifecycle/reopen.js";

/** A finding that names the three fields the interface requires. */
function finding(overrides = {}) {
  return {
    target: "scope",
    relPath: "docs/scope.md",
    summary: "the scope omits the failure path",
    ...overrides,
  };
}

/** Run git in `cwd`, throwing on a non-zero exit so a broken fixture is loud. */
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Write `text` to a repo-relative file, creating any parent directories. */
function write(repo, relPath, text) {
  const abs = join(repo, ...relPath.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

/** Stage everything and commit it, returning the new commit id. */
function commit(repo, message) {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/**
 * Build a throwaway repository in the system temp directory with a local
 * identity, hand it to `fn`, then remove it. The identity is local to the
 * fixture, so the host's git configuration cannot change the result.
 */
async function withTempRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), "yukl-reopen-"));
  try {
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "Yukl Reopen Test"]);
    git(repo, ["config", "user.email", "yukl-reopen-test@example.invalid"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    return await fn(repo);
  } finally {
    await removeTempRepo(repo);
  }
}

/**
 * Best-effort removal of a temp repository. Windows keeps `.git` object files
 * locked for a moment after git exits, so retry briefly on EPERM/EBUSY and give
 * up quietly rather than failing an otherwise green test run.
 */
async function removeTempRepo(repo) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(repo, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err.code !== "EPERM" && err.code !== "EBUSY") return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
}

// ---------------------------------------------------------------------------
// reopen: control
// ---------------------------------------------------------------------------

test("an audit finding reopens scope with a deterministic reopen event", () => {
  const state = { stage: "audit" };
  const theFinding = finding();
  assert.deepEqual(reopen(state, theFinding), {
    type: "reopen",
    data: { from: "audit", to: "scope", finding: theFinding },
    decision: { kind: "deterministic", rule: R_REOPEN },
  });
});

test("a post-merge finding reopens intent, scope or plan from done", () => {
  for (const target of ["intent", "scope", "plan"]) {
    const event = reopen({ stage: "done" }, finding({ target }));
    assert.equal(event.type, "reopen", `${target} must produce a reopen event`);
    assert.equal(event.data.from, "done");
    assert.equal(event.data.to, target);
    assert.equal(event.decision.kind, "deterministic");
    assert.equal(event.decision.rule, R_REOPEN);
  }
});

test("a finding from review or integrate reopens an earlier stage", () => {
  for (const stage of ["review", "integrate"]) {
    const event = reopen({ stage }, finding({ target: "plan" }));
    assert.equal(event.type, "reopen", `${stage} must be able to reopen`);
    assert.equal(event.data.from, stage);
    assert.equal(event.data.to, "plan");
  }
});

test("reopen does not mutate the state or the finding", () => {
  const state = { stage: "audit" };
  const theFinding = finding();
  const stateSnapshot = structuredClone(state);
  const findingSnapshot = structuredClone(theFinding);

  const event = reopen(state, theFinding);

  assert.deepEqual(state, stateSnapshot);
  assert.deepEqual(theFinding, findingSnapshot);
  assert.equal(event.data.finding, theFinding);
});

test("reopen is deterministic for the same state and finding", () => {
  const state = { stage: "audit" };
  const theFinding = finding();
  assert.deepEqual(reopen(state, theFinding), reopen(state, theFinding));
});

// ---------------------------------------------------------------------------
// reopen: must reject a target that is not earlier than the current stage
// ---------------------------------------------------------------------------

test("a reopen targeting the current stage or a later one is refused", () => {
  const cases = [
    { stage: "scope", target: "plan" },
    { stage: "intent", target: "scope" },
    { stage: "intent", target: "plan" },
    { stage: "scope", target: "scope" },
    { stage: "plan", target: "plan" },
  ];
  for (const { stage, target } of cases) {
    const result = reopen({ stage }, finding({ target }));
    assert.equal(result.ok, false, `${stage} -> ${target} must be refused`);
    assert.equal(result.rule, R_REOPEN);
    assert.equal(typeof result.error, "string");
  }
});

// ---------------------------------------------------------------------------
// reopen: must reject a target outside intent, scope and plan
// ---------------------------------------------------------------------------

test("a target that is not intent, scope or plan is refused", () => {
  for (const target of [
    "implement",
    "prove",
    "audit",
    "review",
    "integrate",
    "done",
    "stopped",
    "escalated",
  ]) {
    const result = reopen({ stage: "audit" }, finding({ target }));
    assert.equal(result.ok, false, `${target} must be refused as a target`);
    assert.equal(result.rule, R_REOPEN);
    assert.equal(typeof result.error, "string");
  }
});

test("a malformed finding is refused", () => {
  const badFindings = [
    null,
    undefined,
    "scope",
    [],
    {},
    { target: "scope", relPath: "docs/scope.md" },
    { target: "scope", relPath: "", summary: "why" },
    { target: "scope", relPath: "   ", summary: "why" },
    { target: "scope", relPath: "docs/scope.md", summary: "" },
    { target: 7, relPath: "docs/scope.md", summary: "why" },
  ];
  for (const bad of badFindings) {
    const result = reopen({ stage: "audit" }, bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.equal(result.rule, R_REOPEN);
    assert.equal(typeof result.error, "string");
  }
});

// ---------------------------------------------------------------------------
// reopenedStageComplete: control
// ---------------------------------------------------------------------------

test("an amendment merged into the base ref completes the reopened stage", async () => {
  await withTempRepo(async (repo) => {
    write(repo, "docs/scope.md", "initial scope\n");
    const initial = commit(repo, "add scope");

    // The audit finding reopens scope, naming the artefact to amend.
    const event = reopen({ stage: "audit" }, finding({ target: "scope" }));
    assert.equal(event.type, "reopen");

    // The amendment is made on a branch and merged into the base line.
    git(repo, ["checkout", "-b", "amendment"]);
    write(repo, "docs/scope.md", "amended scope\n");
    const amended = commit(repo, "amend scope");
    git(repo, ["checkout", "main"]);
    git(repo, ["merge", "--no-ff", "-m", "merge amendment", "amendment"]);

    const result = reopenedStageComplete({
      cwd: repo,
      base: "main",
      relPath: "docs/scope.md",
      previousAnchor: { commit: initial },
    });

    assert.equal(result.ok, true);
    assert.equal(result.anchor.path, "docs/scope.md");
    assert.equal(result.anchor.commit, amended);
    assert.notEqual(result.anchor.commit, initial);
    assert.equal(typeof result.anchor.blob, "string");
  });
});

test("an amendment committed directly on the base ref completes the stage", async () => {
  await withTempRepo(async (repo) => {
    write(repo, "docs/scope.md", "initial scope\n");
    const initial = commit(repo, "add scope");
    write(repo, "docs/scope.md", "amended scope\n");
    const amended = commit(repo, "amend scope");

    const result = reopenedStageComplete({
      cwd: repo,
      base: "main",
      relPath: "docs/scope.md",
      previousAnchor: { commit: initial },
    });

    assert.equal(result.ok, true);
    assert.equal(result.anchor.commit, amended);
  });
});

// ---------------------------------------------------------------------------
// reopenedStageComplete: must reject a change that never reached the base ref
// ---------------------------------------------------------------------------

test("an amendment committed only on an unmerged branch does not complete the stage", async () => {
  await withTempRepo(async (repo) => {
    write(repo, "docs/scope.md", "initial scope\n");
    const initial = commit(repo, "add scope");

    git(repo, ["checkout", "-b", "amendment"]);
    write(repo, "docs/scope.md", "amended scope\n");
    const amended = commit(repo, "amend scope on the branch");
    assert.notEqual(amended, initial);

    // The branch is genuinely ahead of the base, but not merged into it.
    assert.equal(git(repo, ["rev-parse", "amendment"]), amended);
    assert.equal(git(repo, ["rev-parse", "main"]), initial);

    const result = reopenedStageComplete({
      cwd: repo,
      base: "main",
      relPath: "docs/scope.md",
      previousAnchor: { commit: initial },
    });

    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, "string");
    assert.match(result.reason, /still anchored|not on main/);
  });
});

test("an uncommitted amendment in the working tree does not complete the stage", async () => {
  await withTempRepo(async (repo) => {
    write(repo, "docs/scope.md", "initial scope\n");
    const initial = commit(repo, "add scope");
    write(repo, "docs/scope.md", "edited but not committed\n");

    const result = reopenedStageComplete({
      cwd: repo,
      base: "main",
      relPath: "docs/scope.md",
      previousAnchor: { commit: initial },
    });

    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, "string");
  });
});

test("an artefact absent from the base ref does not complete the stage", async () => {
  await withTempRepo(async (repo) => {
    write(repo, "docs/other.md", "unrelated\n");
    const initial = commit(repo, "add unrelated file");

    const result = reopenedStageComplete({
      cwd: repo,
      base: "main",
      relPath: "docs/scope.md",
      previousAnchor: { commit: initial },
    });

    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, "string");
  });
});

test("a missing previous anchor is refused without touching the repository", () => {
  for (const previousAnchor of [undefined, null, {}, { commit: "" }, { commit: 7 }]) {
    const result = reopenedStageComplete({
      cwd: "no-such-directory",
      base: "main",
      relPath: "docs/scope.md",
      previousAnchor,
    });
    assert.equal(result.ok, false, `${JSON.stringify(previousAnchor)} must be refused`);
    assert.equal(typeof result.reason, "string");
  }
});

test("a missing argument is refused without touching the repository", () => {
  const bad = [
    {},
    { base: "main", relPath: "docs/scope.md", previousAnchor: { commit: "a".repeat(40) } },
    { cwd: "x", relPath: "docs/scope.md", previousAnchor: { commit: "a".repeat(40) } },
    { cwd: "x", base: "main", previousAnchor: { commit: "a".repeat(40) } },
  ];
  for (const input of bad) {
    const result = reopenedStageComplete(input);
    assert.equal(result.ok, false, `${JSON.stringify(input)} must be refused`);
    assert.equal(typeof result.reason, "string");
  }
});
