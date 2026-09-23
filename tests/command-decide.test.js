import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../scripts/commands/decide.js";
import { appendEvent, foldState, readEvents } from "../scripts/lifecycle/events.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const YUKL = join(ROOT, "scripts", "yukl.js");
const TASK = "task-decide";

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-decide-"));
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

/** Spawn the CLI with YUKL_DISPATCH_ID cleared unless the caller sets it. */
function runCli(args, env = {}) {
  const childEnv = { ...process.env };
  delete childEnv.YUKL_DISPATCH_ID;
  Object.assign(childEnv, env);
  return spawnSync(process.execPath, [YUKL, "decide", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: childEnv,
  });
}

function logBytes(dir, taskId = TASK) {
  return statSync(join(dir, `${taskId}.jsonl`)).size;
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

test("pause then resume at an arbitrary state are both recorded and folded", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "stage_done", actor: "drafter", data: { to: "implement" } });

    const paused = runCli([
      "pause",
      "--task",
      TASK,
      "--by",
      "alice",
      "--reason",
      "hold",
      "--state-dir",
      dir,
    ]);
    assert.equal(paused.status, 0, paused.stderr);

    const resumed = runCli([
      "resume",
      "--task",
      TASK,
      "--by",
      "alice",
      "--reason",
      "go",
      "--state-dir",
      dir,
    ]);
    assert.equal(resumed.status, 0, resumed.stderr);

    const log = readEvents(dir, TASK);
    assert.equal(log.events.length, 3);
    assert.deepEqual(
      log.events
        .slice(1)
        .map((e) => [e.type, e.actor, e.data.decision, e.data.action, e.data.appliedAtSeq]),
      [
        ["human_decision", "human:alice", "pause", "pause", 0],
        ["human_decision", "human:alice", "resume", "resume", 1],
      ],
      "both decisions are recorded with the seq they applied to",
    );
    assert.equal(foldState(log).stage, "implement", "the stage holds through pause and resume");
  });
});

test("run records a pause and returns 0 for a live task", async () => {
  await withTempDir(async (dir) => {
    const saved = process.env.YUKL_DISPATCH_ID;
    delete process.env.YUKL_DISPATCH_ID;
    try {
      const code = await run([
        "pause",
        "--task",
        TASK,
        "--by",
        "alice",
        "--reason",
        "hold",
        "--state-dir",
        dir,
      ]);
      assert.equal(code, 0);
      const event = readEvents(dir, TASK).events[0];
      assert.equal(event.type, "human_decision");
      assert.equal(event.actor, "human:alice");
      assert.equal(event.data.appliedAtSeq, null, "an empty log has no prior seq");
    } finally {
      if (saved !== undefined) process.env.YUKL_DISPATCH_ID = saved;
    }
  });
});

test("an override out of escalated is accepted and folds to the target stage", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "escalated", actor: "drafter", data: { to: "escalated" } });

    const result = runCli([
      "override",
      "--task",
      TASK,
      "--by",
      "root",
      "--reason",
      "resume work",
      "--to",
      "review",
      "--state-dir",
      dir,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const log = readEvents(dir, TASK);
    assert.equal(log.events[1].data.decision, "override");
    assert.equal(log.events[1].data.to, "review");
    assert.equal(foldState(log).stage, "review");
  });
});

test("stop records to stopped and folds the task to the stopped stage", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "stage_done", actor: "drafter", data: { to: "implement" } });

    const result = runCli([
      "stop",
      "--task",
      TASK,
      "--by",
      "root",
      "--reason",
      "abandon",
      "--state-dir",
      dir,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const log = readEvents(dir, TASK);
    assert.equal(log.events[1].data.action, "stop");
    assert.equal(log.events[1].data.to, "stopped");
    assert.equal(foldState(log).stage, "stopped");
  });
});

test("approve is recorded on a live task and leaves the stage unchanged", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "stage_done", actor: "drafter", data: { to: "audit" } });

    const result = runCli([
      "approve",
      "--task",
      TASK,
      "--by",
      "root",
      "--reason",
      "looks good",
      "--state-dir",
      dir,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const log = readEvents(dir, TASK);
    assert.equal(log.events[1].data.decision, "approve");
    assert.equal(foldState(log).stage, "audit");
  });
});

// ---------------------------------------------------------------------------
// must-reject cases (each proves nothing was appended)
// ---------------------------------------------------------------------------

test("a missing --by exits 2 and leaves the log byte for byte unchanged", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "stage_done", actor: "drafter", data: { to: "implement" } });
    const before = logBytes(dir);

    const result = runCli(["pause", "--task", TASK, "--reason", "hold", "--state-dir", dir]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--by/);
    assert.equal(logBytes(dir), before, "a refused decision appends nothing");
  });
});

test("an override on a terminal (done) task exits 1 and appends nothing", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "stage_done", actor: "drafter", data: { to: "done" } });
    const before = logBytes(dir);

    const result = runCli([
      "override",
      "--task",
      TASK,
      "--by",
      "root",
      "--reason",
      "reopen",
      "--to",
      "review",
      "--state-dir",
      dir,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /R-TERMINAL/);
    assert.equal(logBytes(dir), before, "a terminal task cannot be moved");
  });
});

test("any call with YUKL_DISPATCH_ID set exits 1 and appends nothing", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "stage_done", actor: "drafter", data: { to: "implement" } });
    const before = logBytes(dir);

    const result = runCli(
      ["pause", "--task", TASK, "--by", "alice", "--reason", "hold", "--state-dir", dir],
      {
        YUKL_DISPATCH_ID: "dispatch-1",
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /YUKL_DISPATCH_ID/);
    assert.equal(logBytes(dir), before, "a dispatched agent appends nothing");
  });
});

test("the dispatch guard is checked before parsing", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["bogus", "--nope", "x", "--state-dir", dir], {
      YUKL_DISPATCH_ID: "dispatch-1",
    });
    assert.equal(result.status, 1, "the guard wins over the usage error");
    assert.match(result.stderr, /YUKL_DISPATCH_ID/);
  });
});

test("bad usage exits 2 and appends nothing", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "stage_done", actor: "drafter", data: { to: "implement" } });
    const before = logBytes(dir);
    const base = ["--task", TASK, "--by", "alice", "--reason", "because", "--state-dir", dir];
    const cases = [
      [["jump", ...base], /unknown decision/],
      [
        [
          "pause",
          "--task",
          TASK,
          "--by",
          "alice",
          "--reason",
          "because",
          "--bogus",
          "x",
          "--state-dir",
          dir,
        ],
        /unknown option/,
      ],
      [["pause", "--task"], /missing value/],
      [["pause", "--by", "alice", "--reason", "because", "--state-dir", dir], /--task/],
      [["pause", "--task", TASK, "--reason", "because", "--state-dir", dir], /--by/],
      [["pause", "--task", TASK, "--by", "alice", "--state-dir", dir], /--reason/],
      [["override", ...base], /--to/],
      [
        [
          "override",
          "--task",
          TASK,
          "--by",
          "root",
          "--reason",
          "reopen",
          "--to",
          "done",
          "--state-dir",
          dir,
        ],
        /--to/,
      ],
    ];
    for (const [args, pattern] of cases) {
      const result = runCli(args);
      assert.equal(result.status, 2, `expected exit 2 for ${args.join(" ")}`);
      assert.match(result.stderr, pattern);
      assert.equal(logBytes(dir), before, `nothing appended for ${args.join(" ")}`);
    }
  });
});
