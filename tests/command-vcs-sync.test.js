import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withWorkingCopySync } from "../scripts/commands/run.js";
import { parseArgs, run } from "../scripts/commands/vcs-sync.js";
import {
  JJ_WC_BOOKMARK,
  JJ_WC_MESSAGE,
  isJjBookmarkName,
  jjWorkspaceRoot,
  syncJjWorkingCopy,
} from "../scripts/yukl.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const YUKL = join(ROOT, "scripts", "yukl.js");
const GIT_IDENTITY = ["-c", "user.email=yukl-test@example.invalid", "-c", "user.name=Yukl Test"];

// The jj identity is passed per invocation, exactly as tests/init.test.js does,
// so the fixtures never depend on the developer's own jj config.
const JJ_IDENTITY = [
  "--config",
  'user.name="Yukl Test"',
  "--config",
  'user.email="yukl-test@example.com"',
];

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-vcs-sync-"));
  try {
    return await fn(dir);
  } finally {
    // A force-killed command tree can hold the directory briefly on Windows.
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

/** Capture console output around a synchronous or asynchronous call. */
async function capture(fn) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args) => out.push(args.join(" "));
  console.error = (...args) => err.push(args.join(" "));
  try {
    const code = await fn();
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** Run the CLI from the repository root, capturing its status and streams. */
function runCli(args) {
  return spawnSync(process.execPath, [YUKL, ...args], { cwd: ROOT, encoding: "utf8" });
}

function git(args, cwd) {
  const result = spawnSync("git", [...GIT_IDENTITY, ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

function gitOut(args, cwd) {
  return git(args, cwd).stdout.trim();
}

function jjAvailable() {
  return spawnSync("jj", ["--version"], { encoding: "utf8" }).status === 0;
}

const JJ_SKIP = jjAvailable() ? false : "jj binary not available (e.g. on CI)";

function jj(cwd, args) {
  const result = spawnSync("jj", [...JJ_IDENTITY, "--repository", cwd, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `jj ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

function jjOut(cwd, args) {
  return jj(cwd, args).stdout.trim();
}

/** A colocated Jujutsu/Git workspace in `dir`, built only through the jj CLI. */
function colocatedRepo(dir) {
  const init = spawnSync("jj", [...JJ_IDENTITY, "git", "init", "--colocate", dir], {
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
}

/** A runtime whose four entry points are all observable, plus the dispatch log. */
function fakeRuntime() {
  const starts = [];
  const runtime = {
    start(dispatch) {
      starts.push(dispatch);
      return "run-1";
    },
    status(id) {
      return `status:${id}`;
    },
    result(id) {
      return { id };
    },
    stop(id) {
      return `stopped:${id}`;
    },
  };
  return { runtime, starts };
}

// ---------------------------------------------------------------------------
// parseArgs: usage handling before any repository is touched
// ---------------------------------------------------------------------------

test("vcs-sync parseArgs defaults to the working-copy bookmark and no cwd", () => {
  assert.deepEqual(parseArgs([]), {
    cwd: null,
    bookmark: JJ_WC_BOOKMARK,
    message: null,
    json: false,
  });
});

test("vcs-sync parseArgs reads --json and every value flag", () => {
  assert.deepEqual(parseArgs(["--json"]), {
    cwd: null,
    bookmark: JJ_WC_BOOKMARK,
    message: null,
    json: true,
  });
  assert.equal(parseArgs(["--cwd", "some/dir"]).cwd, "some/dir");
  assert.equal(parseArgs(["--bookmark", "feature/sync"]).bookmark, "feature/sync");
  assert.equal(
    parseArgs(["--message", "publish the working copy"]).message,
    "publish the working copy",
  );
  assert.deepEqual(parseArgs(["--cwd", "d", "--bookmark", "b", "--message", "m", "--json"]), {
    cwd: "d",
    bookmark: "b",
    message: "m",
    json: true,
  });
});

test("vcs-sync parseArgs refuses a missing value, an unknown flag, a stray positional and a bad bookmark", () => {
  // Every case returns an error object, so no caller ever reaches a jj spawn.
  for (const flag of ["--cwd", "--bookmark", "--message"]) {
    assert.deepEqual(parseArgs([flag]), { error: `${flag} requires a value` });
    assert.deepEqual(parseArgs(["--json", flag]), { error: `${flag} requires a value` });
  }
  assert.deepEqual(parseArgs(["--bogus"]), { error: "unknown option --bogus" });
  assert.deepEqual(parseArgs(["publish"]), { error: 'unexpected argument "publish"' });
  assert.deepEqual(parseArgs(["--bookmark", "bad..name"]), {
    error: '--bookmark "bad..name" is not a valid bookmark name',
  });
  assert.deepEqual(parseArgs(["--bookmark", "trailing/"]), {
    error: '--bookmark "trailing/" is not a valid bookmark name',
  });
});

test("vcs-sync run returns 2 with usage on every argument error", async () => {
  const cases = [
    [["--bogus"], /unknown option --bogus/],
    [["publish"], /unexpected argument "publish"/],
    [["--cwd"], /--cwd requires a value/],
    [["--bookmark", "bad..name"], /is not a valid bookmark name/],
  ];
  for (const [args, pattern] of cases) {
    const result = await capture(() => run(args));
    assert.equal(result.code, 2, `expected exit 2 for ${args.join(" ")}`);
    assert.match(result.err, pattern);
    assert.match(result.err, /usage:/);
  }
});

// ---------------------------------------------------------------------------
// isJjBookmarkName: the syntactic check that keeps exit 2 ahead of jj
// ---------------------------------------------------------------------------

test("isJjBookmarkName accepts Git-branch-shaped names", () => {
  for (const name of ["yukl-wc", "main", "a", "A1", "feature/sync", "release_1.2", "a.b_c-d/e"]) {
    assert.equal(isJjBookmarkName(name), true, `${name} must be accepted`);
  }
});

test("isJjBookmarkName refuses malformed names and non-strings", () => {
  const rejected = ["", "..", "a..b", "-lead", ".lead", "trailing/", "a.lock", "a b", "a\u00e9b"];
  for (const name of rejected) {
    assert.equal(isJjBookmarkName(name), false, `${name} must be refused`);
  }
  for (const value of [null, undefined, 42, {}, ["main"]]) {
    assert.equal(isJjBookmarkName(value), false, `${String(value)} must be refused`);
  }
});

// ---------------------------------------------------------------------------
// withWorkingCopySync: the dispatcher hook yukl run applies per agent start
// ---------------------------------------------------------------------------

test("withWorkingCopySync refuses to dispatch when the sync fails and never starts the runtime", async () => {
  await withTempDir(async (dir) => {
    const { runtime, starts } = fakeRuntime();
    const guarded = withWorkingCopySync(runtime, { cwd: dir, bookmark: "bad..name" });

    assert.throws(
      () => guarded.start({ stage: "implement" }),
      /refusing to dispatch an agent: "bad\.\.name" is not a valid Jujutsu bookmark name/,
    );
    assert.deepEqual(starts, [], "the wrapped runtime's start is never reached");
  });
});

test("withWorkingCopySync fails closed when .jj is present but jj cannot be run", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, ".jj"));
    const { runtime, starts } = fakeRuntime();
    const guarded = withWorkingCopySync(runtime, { cwd: dir, bookmark: JJ_WC_BOOKMARK });

    const path = process.env.PATH;
    const emptyPath = join(dir, "empty-path");
    mkdirSync(emptyPath);
    try {
      // jj is unrunnable below, so the workspace can never be published and the
      // start must be refused rather than dispatched unsynced.
      process.env.PATH = emptyPath;
      assert.throws(() => guarded.start({ stage: "implement" }), /refusing to dispatch an agent/);
      assert.throws(() => guarded.start({ stage: "implement" }), /jj could not be run/);
    } finally {
      process.env.PATH = path;
    }
    assert.deepEqual(starts, [], "the wrapped runtime's start is never reached");
  });
});

test("withWorkingCopySync passes a dispatch through untouched when the sync succeeds", async () => {
  await withTempDir(async (dir) => {
    const { runtime, starts } = fakeRuntime();
    const guarded = withWorkingCopySync(runtime, { cwd: dir, bookmark: JJ_WC_BOOKMARK });

    // A temp directory is not a Jujutsu workspace, so the sync is a no-op that
    // still counts as success: nothing to publish is not a failure.
    const dispatch = { stage: "implement", spec: "write the tests" };
    assert.equal(guarded.start(dispatch), "run-1");
    assert.equal(starts.length, 1, "start is called exactly once");
    assert.equal(starts[0], dispatch, "the same dispatch object reaches the runtime");

    assert.equal(guarded.status("run-1"), "status:run-1");
    assert.equal(guarded.result("run-1").id, "run-1");
    assert.equal(guarded.stop("run-1"), "stopped:run-1");
    assert.equal(guarded.status, runtime.status, "status is untouched");
    assert.equal(guarded.result, runtime.result, "result is untouched");
    assert.equal(guarded.stop, runtime.stop, "stop is untouched");
    assert.equal(Object.getPrototypeOf(guarded), runtime, "only start is overridden");
  });
});

// ---------------------------------------------------------------------------
// jjWorkspaceRoot and the CLI outside Jujutsu
// ---------------------------------------------------------------------------

test("jjWorkspaceRoot reports no workspace in a plain Git repository", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "README.md"), "plain\n");
    git(["init", "-q"], dir);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "seed"], dir);

    assert.deepEqual(
      jjWorkspaceRoot(dir),
      { root: null, error: null },
      "a plain Git repository is not an error, just nothing to publish",
    );
  });
});

test("vcs-sync exits 0 and publishes nothing in a plain Git repository", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "README.md"), "plain\n");
    git(["init", "-q"], dir);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "seed"], dir);

    const summary = runCli(["vcs-sync", "--cwd", dir]);
    assert.equal(summary.status, 0, summary.stderr);
    assert.match(summary.stdout, /no Jujutsu workspace/);
    assert.match(summary.stdout, /nothing to publish/);

    const json = runCli(["vcs-sync", "--cwd", dir, "--json"]);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout.trim()), {
      ok: true,
      synced: false,
      reason: "no Jujutsu workspace",
    });

    const inProcess = await capture(() => run(["--cwd", dir]));
    assert.equal(inProcess.code, 0, inProcess.err);
    assert.match(inProcess.out, /nothing to publish/);

    // Nothing was published, so no working-copy branch exists here.
    const ref = spawnSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/heads/${JJ_WC_BOOKMARK}`],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );
    assert.notEqual(ref.status, 0, "a plain Git repository gains no working-copy ref");
  });
});

// ---------------------------------------------------------------------------
// the real jj binary: publication of a colocated working copy
// ---------------------------------------------------------------------------

test(
  "syncJjWorkingCopy describes an undescribed working copy and points the Git branch at it",
  { skip: JJ_SKIP },
  async () => {
    await withTempDir(async (dir) => {
      colocatedRepo(dir);
      writeFileSync(join(dir, "README.md"), "base\n");
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "x.js"), "x\n");
      assert.equal(jjOut(dir, ["log", "-r", "@", "--no-graph", "-T", "description"]), "");

      const result = syncJjWorkingCopy({ cwd: dir });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.synced, true);
      assert.equal(result.described, true, "an undescribed @ is described");
      assert.equal(result.moved, true, "the bookmark did not exist before");
      assert.equal(result.bookmark, JJ_WC_BOOKMARK);
      assert.equal(result.ref, `refs/heads/${JJ_WC_BOOKMARK}`);

      const at = jjOut(dir, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
      assert.match(at, /^[0-9a-f]{40}$/);
      assert.equal(result.commit, at);
      assert.equal(
        jjOut(dir, ["log", "-r", "@", "--no-graph", "-T", "description"]),
        JJ_WC_MESSAGE,
      );
      assert.equal(
        gitOut(["rev-parse", `refs/heads/${JJ_WC_BOOKMARK}`], dir),
        at,
        "the Git branch points at @'s commit",
      );

      // Running it a second time has nothing left to do.
      const again = await capture(() => run(["--cwd", dir]));
      assert.equal(again.code, 0, again.err);
      assert.match(again.out, /already published/);
      assert.ok(!/described and/.test(again.out), "the working copy is already described");
    });
  },
);

test(
  "syncJjWorkingCopy never overwrites a description the working copy already has",
  { skip: JJ_SKIP },
  async () => {
    await withTempDir(async (dir) => {
      colocatedRepo(dir);
      writeFileSync(join(dir, "README.md"), "base\n");
      jj(dir, ["describe", "-m", "base"]);
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "x.js"), "x\n");

      const result = syncJjWorkingCopy({ cwd: dir });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.described, false, "an existing description is left alone");
      assert.equal(result.moved, true, "the ref is created on this first run");
      assert.equal(
        jjOut(dir, ["log", "-r", "@", "--no-graph", "-T", "description"]),
        "base",
        "the author's description survives the sync",
      );
      assert.equal(
        gitOut(["rev-parse", `refs/heads/${JJ_WC_BOOKMARK}`], dir),
        result.commit,
        "the Git branch points at @'s commit",
      );

      const second = syncJjWorkingCopy({ cwd: dir });
      assert.equal(second.ok, true, second.error);
      assert.equal(second.described, false);
      assert.equal(second.moved, false, "the ref already names @");
      assert.equal(second.commit, result.commit);
      assert.equal(jjOut(dir, ["log", "-r", "@", "--no-graph", "-T", "description"]), "base");
    });
  },
);

test(
  "syncJjWorkingCopy moves a bookmark that is behind the working copy onto it",
  { skip: JJ_SKIP },
  async () => {
    await withTempDir(async (dir) => {
      colocatedRepo(dir);
      writeFileSync(join(dir, "README.md"), "base\n");
      jj(dir, ["describe", "-m", "base"]);
      jj(dir, ["bookmark", "create", "main", "-r", "@"]);

      const first = syncJjWorkingCopy({ cwd: dir });
      assert.equal(first.ok, true, first.error);
      assert.equal(first.moved, true);
      const published = first.commit;

      // A new empty working-copy commit leaves the published bookmark behind.
      jj(dir, ["new"]);
      jj(dir, ["describe", "-m", ""]);
      const ahead = jjOut(dir, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
      assert.notEqual(ahead, published, "the working copy moved on");
      assert.equal(
        gitOut(["rev-parse", `refs/heads/${JJ_WC_BOOKMARK}`], dir),
        published,
        "the Git branch is still behind @",
      );

      const second = syncJjWorkingCopy({ cwd: dir });
      assert.equal(second.ok, true, second.error);
      assert.equal(second.moved, true, "the bookmark is moved onto @");
      assert.equal(second.described, true, "the new @ is described");
      // Describing rewrites the commit, so the published commit is read back.
      const now = jjOut(dir, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
      assert.notEqual(now, ahead, "describing rewrites the working-copy commit");
      assert.equal(second.commit, now);
      assert.equal(gitOut(["rev-parse", `refs/heads/${JJ_WC_BOOKMARK}`], dir), now);
      assert.equal(
        jjOut(dir, ["log", "-r", JJ_WC_BOOKMARK, "--no-graph", "-T", "commit_id"]),
        now,
        "the jj bookmark itself names @",
      );
    });
  },
);
