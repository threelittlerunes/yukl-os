import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { anchorAt, isAncestor } from "../scripts/lifecycle/anchors.js";

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
 * Build a throwaway repository in the system temp directory, hand it to `fn`,
 * then remove it. The user identity is local to the fixture, so the host's git
 * configuration cannot change the result.
 */
async function withTempRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), "yukl-anchors-"));
  try {
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "Yukl Anchor Test"]);
    git(repo, ["config", "user.email", "yukl-anchor-test@example.invalid"]);
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

test("anchorAt anchors a committed file to its last commit and blob", async () => {
  await withTempRepo(async (repo) => {
    write(repo, "docs/note.md", "first\n");
    commit(repo, "add note");
    write(repo, "docs/note.md", "second\n");
    const head = commit(repo, "revise note");
    const blob = git(repo, ["rev-parse", "HEAD:docs/note.md"]);

    assert.deepEqual(anchorAt(repo, "main", "docs/note.md"), {
      ok: true,
      path: "docs/note.md",
      commit: head,
      blob,
    });
  });
});

test("anchorAt normalises a backslash path and accepts HEAD as the ref", async () => {
  await withTempRepo(async (repo) => {
    write(repo, "docs/note.md", "hello\n");
    const head = commit(repo, "add note");
    const blob = git(repo, ["rev-parse", "HEAD:docs/note.md"]);

    assert.deepEqual(anchorAt(repo, "HEAD", "docs\\note.md"), {
      ok: true,
      path: "docs/note.md",
      commit: head,
      blob,
    });
  });
});

test("anchorAt rejects a file present in the working tree but uncommitted", async () => {
  await withTempRepo(async (repo) => {
    write(repo, "docs/tracked.md", "committed\n");
    commit(repo, "add tracked note");
    write(repo, "docs/untracked.md", "not committed\n");
    assert.equal(existsSync(join(repo, "docs", "untracked.md")), true);

    const result = anchorAt(repo, "main", "docs/untracked.md");
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, "string");
  });
});

test("anchorAt rejects a file committed only on a branch not reachable from the ref", async () => {
  await withTempRepo(async (repo) => {
    write(repo, "docs/base.md", "base\n");
    const base = commit(repo, "base commit");

    git(repo, ["checkout", "-b", "side"]);
    write(repo, "docs/side-only.md", "side\n");
    const sideCommit = commit(repo, "side commit");
    git(repo, ["checkout", "main"]);

    // The file is genuinely committed, but only on `side`.
    assert.equal(anchorAt(repo, "side", "docs/side-only.md").ok, true);
    assert.equal(isAncestor(repo, sideCommit, "main"), false);
    assert.equal(isAncestor(repo, base, "main"), true);

    const result = anchorAt(repo, "main", "docs/side-only.md");
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, "string");
  });
});

test("anchorAt refuses absolute paths", async () => {
  await withTempRepo(async (repo) => {
    write(repo, "docs/note.md", "hello\n");
    commit(repo, "add note");

    const absolutes = ["/etc/passwd", "C:\\Windows\\system32\\drivers", "\\\\server\\share\\file"];
    for (const bad of absolutes) {
      const result = anchorAt(repo, "main", bad);
      assert.equal(result.ok, false, `${bad} must be refused`);
      assert.equal(typeof result.error, "string");
    }
  });
});

test("anchorAt refuses a path with a parent segment", async () => {
  await withTempRepo(async (repo) => {
    write(repo, "docs/note.md", "hello\n");
    commit(repo, "add note");

    for (const bad of ["..", "../outside.md", "docs/../../etc/passwd"]) {
      const result = anchorAt(repo, "main", bad);
      assert.equal(result.ok, false, `${bad} must be refused`);
      assert.equal(typeof result.error, "string");
    }
  });
});

test("isAncestor is true for an ancestor and false for a descendant", async () => {
  await withTempRepo(async (repo) => {
    write(repo, "a.txt", "one\n");
    const first = commit(repo, "first");
    write(repo, "a.txt", "two\n");
    const second = commit(repo, "second");

    assert.equal(isAncestor(repo, first, "main"), true);
    assert.equal(isAncestor(repo, second, "main"), true);
    assert.equal(isAncestor(repo, first, second), true);
    assert.equal(isAncestor(repo, second, first), false);
  });
});

test("isAncestor surfaces an unknown revision as an error", async () => {
  await withTempRepo(async (repo) => {
    write(repo, "a.txt", "one\n");
    commit(repo, "first");

    assert.throws(
      () => isAncestor(repo, "no-such-revision", "main"),
      /valid object|bad revision|merge-base|unknown revision/i,
    );
  });
});
