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
    json: false,
  });
});

test("vcs-sync parseArgs reads --json and every value flag", () => {
  assert.deepEqual(parseArgs(["--json"]), {
    cwd: null,
    bookmark: JJ_WC_BOOKMARK,
    json: true,
  });
  assert.equal(parseArgs(["--cwd", "some/dir"]).cwd, "some/dir");
  assert.equal(parseArgs(["--bookmark", "feature/sync"]).bookmark, "feature/sync");
  assert.deepEqual(parseArgs(["--cwd", "d", "--bookmark", "b", "--json"]), {
    cwd: "d",
    bookmark: "b",
    json: true,
  });
});

test("vcs-sync parseArgs refuses a missing value, an unknown flag, a stray positional and a bad bookmark", () => {
  // Every case returns an error object, so no caller ever reaches a jj spawn.
  for (const flag of ["--cwd", "--bookmark"]) {
    assert.deepEqual(parseArgs([flag]), { error: `${flag} requires a value` });
    assert.deepEqual(parseArgs(["--json", flag]), { error: `${flag} requires a value` });
  }
  assert.deepEqual(parseArgs(["--bogus"]), { error: "unknown option --bogus" });
  // The sync never describes `@`, so it takes no message to describe it with.
  assert.deepEqual(parseArgs(["--message", "publish"]), { error: "unknown option --message" });
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
    [["--message", "m"], /unknown option --message/],
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
// jjWorkspaceRoot fails closed: an unreadable workspace is never "plain Git"
// ---------------------------------------------------------------------------

/** Hide jj from PATH for the duration of `fn`, so it cannot be run at all. */
async function withoutJj(dir, fn) {
  const path = process.env.PATH;
  const emptyPath = join(dir, "empty-path");
  mkdirSync(emptyPath);
  try {
    process.env.PATH = emptyPath;
    return await fn();
  } finally {
    process.env.PATH = path;
  }
}

test("jjWorkspaceRoot reports no workspace for a tree without .jj, even with jj unrunnable", async () => {
  await withTempDir(async (dir) => {
    // No .jj anywhere: jj failing is what plain Git looks like, so the caller
    // must not be told a workspace exists that it could not publish.
    await withoutJj(dir, () => {
      assert.deepEqual(jjWorkspaceRoot(dir), { root: null, error: null });
    });
    assert.deepEqual(jjWorkspaceRoot(dir), { root: null, error: null });
    assert.deepEqual(jjWorkspaceRoot(join(dir, "does", "not", "exist")), {
      root: null,
      error: null,
    });
  });
});

test("jjWorkspaceRoot fails closed when .jj is in cwd and jj cannot be run", async () => {
  await withTempDir(async (dir) => {
    const workspace = join(dir, "workspace");
    mkdirSync(join(workspace, ".jj"), { recursive: true });

    await withoutJj(dir, () => {
      const located = jjWorkspaceRoot(workspace);
      assert.equal(located.root, null, "an unreadable workspace resolves to no root");
      assert.match(located.error, /\.jj is present in /);
      assert.ok(located.error.includes(workspace), "the error names the directory holding .jj");
      assert.match(located.error, /jj could not be run/);
    });
  });
});

test("jjWorkspaceRoot fails closed when .jj is in a parent directory and jj cannot be run", async () => {
  await withTempDir(async (dir) => {
    const workspace = join(dir, "workspace");
    const cwd = join(workspace, "sub", "deeper");
    mkdirSync(join(workspace, ".jj"), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    await withoutJj(dir, () => {
      const located = jjWorkspaceRoot(cwd);
      assert.equal(located.root, null);
      assert.ok(
        located.error.includes(workspace),
        "the walk up the tree names the directory that holds .jj",
      );
      assert.ok(!located.error.includes(cwd), "the error names that directory, not the cwd");
      assert.match(located.error, /jj could not be run/);
    });
  });
});

test(
  "jjWorkspaceRoot fails closed and names jj's first stderr line when jj root exits non-zero",
  { skip: JJ_SKIP },
  async () => {
    await withTempDir(async (dir) => {
      // A .jj that is not a real workspace: jj finds the marker and then fails,
      // which is the case that used to pass as "no workspace at all".
      const workspace = join(dir, "parent");
      mkdirSync(join(workspace, ".jj"), { recursive: true });
      writeFileSync(join(workspace, ".jj", "repo"), "not a workspace\n");
      const cwd = join(workspace, "sub", "deeper");
      mkdirSync(cwd, { recursive: true });

      const direct = spawnSync("jj", ["root"], { cwd, encoding: "utf8" });
      assert.notEqual(direct.status, 0, "the fixture makes jj root fail");
      const firstStderr = direct.stderr
        .split(/\r?\n/)
        .find((line) => line.trim() !== "")
        .trim();

      for (const [where, from] of [
        ["a subdirectory", cwd],
        ["the workspace directory", workspace],
      ]) {
        const located = jjWorkspaceRoot(from);
        assert.equal(located.root, null, `no root from ${where}`);
        assert.match(located.error, /\.jj is present in /);
        assert.ok(located.error.includes(workspace), `the error from ${where} names the directory`);
        assert.ok(
          located.error.includes(firstStderr),
          `the error from ${where} names jj's first stderr line`,
        );
        assert.match(located.error, /jj root failed: /);
      }

      // The command refuses instead of publishing, and says so on stderr.
      const cli = runCli(["vcs-sync", "--cwd", cwd]);
      assert.equal(cli.status, 1, cli.stdout);
      assert.match(cli.stderr, /\.jj is present in /);
      assert.ok(cli.stderr.includes(workspace));

      const json = runCli(["vcs-sync", "--cwd", cwd, "--json"]);
      assert.equal(json.status, 1);
      assert.equal(JSON.parse(json.stdout.trim()).ok, false);
    });
  },
);

// ---------------------------------------------------------------------------
// the real jj binary: publication of a colocated working copy
// ---------------------------------------------------------------------------

test(
  "syncJjWorkingCopy publishes an undescribed working copy and points the Git branch at it",
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
      assert.equal(result.moved, true, "the bookmark did not exist before");
      assert.equal(result.bookmark, JJ_WC_BOOKMARK);
      assert.equal(result.ref, `refs/heads/${JJ_WC_BOOKMARK}`);

      const at = jjOut(dir, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
      assert.match(at, /^[0-9a-f]{40}$/);
      assert.equal(result.commit, at);
      assert.equal(
        jjOut(dir, ["log", "-r", "@", "--no-graph", "-T", "description"]),
        "",
        "an undescribed @ is published as it is, never described",
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
      assert.ok(!/described/.test(again.out), "the sync never reports a description");
    });
  },
);

test(
  "syncJjWorkingCopy leaves an existing description byte-for-byte unchanged",
  { skip: JJ_SKIP },
  async () => {
    await withTempDir(async (dir) => {
      colocatedRepo(dir);
      writeFileSync(join(dir, "README.md"), "base\n");
      jj(dir, ["describe", "-m", "base\n\nsecond line"]);
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "x.js"), "x\n");

      const rawDescription = () => jj(dir, ["log", "-r", "@", "--no-graph", "-T", "description"]);
      const descriptionBefore = rawDescription().stdout;
      assert.match(descriptionBefore, /second line/);
      const commitBefore = jjOut(dir, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);

      const result = syncJjWorkingCopy({ cwd: dir });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.moved, true, "the ref is created on this first run");
      assert.equal(result.commit, commitBefore, "the sync publishes @ without rewriting it");
      assert.equal(
        rawDescription().stdout,
        descriptionBefore,
        "the author's description survives the sync untouched",
      );
      assert.equal(
        gitOut(["rev-parse", `refs/heads/${JJ_WC_BOOKMARK}`], dir),
        result.commit,
        "the Git branch points at @'s commit",
      );

      const second = syncJjWorkingCopy({ cwd: dir });
      assert.equal(second.ok, true, second.error);
      assert.equal(second.moved, false, "the ref already names @");
      assert.equal(second.commit, result.commit);
      assert.equal(rawDescription().stdout, descriptionBefore);
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
      // The sync never describes @, so the published commit is the very one
      // that was read before the move.
      const now = jjOut(dir, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
      assert.equal(now, ahead, "an undescribed @ is published without being rewritten");
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

test(
  "syncJjWorkingCopy accepts a custom bookmark that already points at the working copy",
  { skip: JJ_SKIP },
  async () => {
    await withTempDir(async (dir) => {
      colocatedRepo(dir);
      writeFileSync(join(dir, "README.md"), "base\n");
      jj(dir, ["bookmark", "create", "mine", "-r", "@"]);
      const commit = jjOut(dir, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);

      const result = syncJjWorkingCopy({ cwd: dir, bookmark: "mine" });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.commit, commit);
      assert.equal(gitOut(["rev-parse", "refs/heads/mine"], dir), commit, "Git now names @ too");
      assert.equal(jjOut(dir, ["log", "-r", "mine", "--no-graph", "-T", "commit_id"]), commit);
      assert.equal(
        jjOut(dir, ["log", "-r", "@", "--no-graph", "-T", "description"]),
        "",
        "the working copy is still undescribed",
      );

      // Moving a bookmark that already points at @ is a no-op, not a refusal.
      const second = syncJjWorkingCopy({ cwd: dir, bookmark: "mine" });
      assert.equal(second.ok, true, second.error);
      assert.equal(second.moved, false, "Git already names @: nothing left to do");
      assert.equal(second.commit, commit);
    });
  },
);

test(
  "syncJjWorkingCopy refuses a custom bookmark that does not point at the working copy",
  { skip: JJ_SKIP },
  async () => {
    await withTempDir(async (dir) => {
      colocatedRepo(dir);
      writeFileSync(join(dir, "README.md"), "base\n");
      jj(dir, ["describe", "-m", "base"]);
      jj(dir, ["bookmark", "create", "main", "-r", "@"]);
      const main = jjOut(dir, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]);
      // The user keeps working, so @ moves ahead of the branch they own.
      jj(dir, ["new"]);
      jj(dir, ["describe", "-m", ""]);
      const workingCopy = jjOut(dir, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
      assert.notEqual(workingCopy, main, "main is behind @");

      const refused = syncJjWorkingCopy({ cwd: dir, bookmark: "main" });
      assert.equal(refused.ok, false, "a user bookmark is never moved");
      assert.match(refused.error, /refusing to move the existing bookmark main/);
      assert.match(refused.error, /it is not the yukl working-copy bookmark yukl-wc/);
      assert.match(refused.error, /does not already point at the working copy \(@\)/);

      // The refusal writes nothing at all: the branch, its Git ref and the
      // working copy are exactly where the user left them.
      assert.equal(jjOut(dir, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]), main);
      assert.equal(gitOut(["rev-parse", "refs/heads/main"], dir), main);
      assert.equal(jjOut(dir, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]), workingCopy);
      assert.equal(
        jjOut(dir, ["log", "-r", "@", "--no-graph", "-T", "description"]),
        "",
        "the working copy is not described either",
      );
      assert.equal(
        jjOut(dir, ["bookmark", "list", JJ_WC_BOOKMARK, "-T", "name"]),
        "",
        "the sync created no working-copy bookmark of its own",
      );

      // The command reports the refusal as exit 1 rather than publishing.
      const cli = runCli(["vcs-sync", "--cwd", dir, "--bookmark", "main"]);
      assert.equal(cli.status, 1, cli.stdout);
      assert.match(cli.stderr, /refusing to move the existing bookmark main/);
    });
  },
);

test(
  "syncJjWorkingCopy refuses to move a bookmark that tracks a remote",
  { skip: JJ_SKIP },
  async () => {
    await withTempDir(async (dir) => {
      const remote = join(dir, "remote.git");
      git(["init", "-q", "--bare", remote], dir);
      const workspace = join(dir, "ws");
      colocatedRepo(workspace);
      writeFileSync(join(workspace, "README.md"), "base\n");
      jj(workspace, ["describe", "-m", "base"]);
      jj(workspace, ["bookmark", "create", "shared", "-r", "@"]);
      jj(workspace, ["git", "remote", "add", "origin", remote]);
      jj(workspace, ["git", "push", "--bookmark", "shared"]);
      jj(workspace, ["git", "fetch"]);
      assert.notEqual(
        jjOut(workspace, [
          "log",
          "-r",
          'tracked_remote_bookmarks(exact:"shared")',
          "--no-graph",
          "-T",
          "commit_id",
        ]),
        "",
        "the fixture tracks origin/shared",
      );

      jj(workspace, ["new"]);
      jj(workspace, ["describe", "-m", ""]);
      const before = jjOut(workspace, ["log", "-r", "shared", "--no-graph", "-T", "commit_id"]);

      const refused = syncJjWorkingCopy({ cwd: workspace, bookmark: "shared" });
      assert.equal(refused.ok, false, "a branch someone else can see is never rewritten");
      assert.match(refused.error, /refusing to move the existing bookmark shared/);
      assert.match(refused.error, /it tracks a remote/);
      assert.equal(
        jjOut(workspace, ["log", "-r", "shared", "--no-graph", "-T", "commit_id"]),
        before,
        "the bookmark is untouched",
      );
      assert.equal(gitOut(["rev-parse", "refs/heads/shared"], workspace), before);
    });
  },
);

test(
  "syncJjWorkingCopy fails closed when Git cannot confirm the exported ref",
  { skip: JJ_SKIP },
  async () => {
    await withTempDir(async (dir) => {
      colocatedRepo(dir);
      writeFileSync(join(dir, "README.md"), "base\n");

      // jj publishes into its own store, while `git` is pointed at a different
      // repository: the export itself succeeds, but the proof that Git resolves
      // the ref cannot hold, and a sync that cannot prove itself must not pass.
      const decoy = join(dir, "decoy");
      git(["init", "-q", decoy], dir);
      const gitDir = process.env.GIT_DIR;
      process.env.GIT_DIR = decoy;
      let refused;
      try {
        refused = syncJjWorkingCopy({ cwd: dir });
      } finally {
        if (gitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = gitDir;
      }

      assert.equal(refused.ok, false);
      assert.match(refused.error, /resolves to nothing but the Jujutsu working copy is /);
      assert.match(refused.error, /the working copy was not published/);
      // jj did move its own bookmark: only the Git-side proof failed.
      assert.match(
        jjOut(dir, ["log", "-r", JJ_WC_BOOKMARK, "--no-graph", "-T", "commit_id"]),
        /^[0-9a-f]{40}$/,
      );

      // With Git back, the same sync publishes and proves it.
      const published = syncJjWorkingCopy({ cwd: dir });
      assert.equal(published.ok, true, published.error);
      assert.equal(
        published.commit,
        jjOut(dir, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]),
      );
      assert.equal(gitOut(["rev-parse", `refs/heads/${JJ_WC_BOOKMARK}`], dir), published.commit);
    });
  },
);
