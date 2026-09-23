import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  foldState,
  headHash,
  readEvents,
  verifyAgainstHead,
  verifyChain,
} from "../scripts/lifecycle/events.js";

const TASK = "task-1";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function logPath(dir, taskId = TASK) {
  return join(dir, `${taskId}.jsonl`);
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-events-"));
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

test("appendEvent and readEvents round-trip a chained log", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "stage-start", actor: "drafter", data: { stage: "build" } });
    appendEvent(dir, TASK, { type: "attempt", actor: "drafter", data: {} });
    appendEvent(dir, TASK, { type: "stage-complete", actor: "drafter", data: { to: "test" } });

    const log = readEvents(dir, TASK);
    assert.deepEqual(log.partialTail, null, "a complete log has no partial tail");
    assert.equal(log.events.length, 3);
    assert.equal(log.lines.length, 3);

    assert.deepEqual(
      log.events.map((e) => e.seq),
      [0, 1, 2],
      "seq counts from 0 without gaps",
    );
    assert.equal(log.events[0].prev, null, "the first event chains to nothing");
    assert.equal(log.events[1].prev, sha256(log.lines[0]));
    assert.equal(log.events[2].prev, sha256(log.lines[1]));

    for (const event of log.events) {
      assert.equal(event.taskId, TASK);
      assert.equal(typeof event.at, "string");
      assert.ok(!Number.isNaN(Date.parse(event.at)), "at is an ISO timestamp");
    }
  });
});

test("appendEvent owns seq and prev and ignores caller bookkeeping", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "start", actor: "a", data: {}, seq: 99, prev: "deadbeef" });
    appendEvent(dir, TASK, { type: "finish", actor: "a", data: {} });
    const log = readEvents(dir, TASK);
    assert.equal(log.events[0].seq, 0);
    assert.equal(log.events[0].prev, null);
    assert.equal(log.events[1].seq, 1);
    assert.equal(log.events[1].prev, sha256(log.lines[0]));
  });
});

test("appendEvent rejects an unsafe taskId before touching the filesystem", async () => {
  await withTempDir(async (dir) => {
    const logs = join(dir, "logs");
    for (const bad of ["../evil", "a/b", "a\\b", "", "Upper", ".hidden", "with space", null, 5]) {
      assert.throws(() => appendEvent(logs, bad, { type: "x", actor: "a" }), /invalid taskId/);
      assert.throws(() => readEvents(logs, bad), /invalid taskId/);
    }
    assert.equal(existsSync(logs), false, "no directory is created for a rejected taskId");
  });
});

test("a three-event log folds to the expected state after re-reading from disk", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "stage-start", actor: "drafter", data: { stage: "build" } });
    appendEvent(dir, TASK, { type: "attempt", actor: "drafter", data: {} });
    appendEvent(dir, TASK, { type: "stage-complete", actor: "drafter", data: { to: "test" } });

    const state = foldState(readEvents(dir, TASK));
    assert.equal(state.taskId, TASK);
    assert.equal(state.stage, "test", "the latest transition target wins");
    assert.equal(state.attempts, 1, "the attempt event is counted");
    assert.equal(state.count, 3);
    assert.equal(state.lastEvent.type, "stage-complete");
    assert.equal(state.lastEvent.seq, 2);
  });
});

test("verifyChain accepts an intact log given as a result or a bare array", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "start", actor: "a", data: {} });
    appendEvent(dir, TASK, { type: "finish", actor: "a", data: {} });
    const log = readEvents(dir, TASK);
    assert.deepEqual(verifyChain(log), { ok: true });
    assert.deepEqual(verifyChain(log.events), { ok: true });
  });
});

test("an empty log verifies, has no head and folds to an empty state", async () => {
  await withTempDir(async (dir) => {
    const log = readEvents(dir, TASK);
    assert.deepEqual(log, { events: [], lines: [], partialTail: null });
    assert.deepEqual(verifyChain(log), { ok: true });
    assert.equal(headHash(log), null);
    assert.deepEqual(verifyAgainstHead(log, null), { ok: true });
    assert.equal(verifyAgainstHead(log, "a".repeat(64)).ok, false);
    assert.deepEqual(foldState(log), {
      taskId: null,
      stage: null,
      attempts: 0,
      lastEvent: null,
      count: 0,
    });
  });
});

test("headHash is the SHA-256 of the last raw line", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "start", actor: "a", data: {} });
    appendEvent(dir, TASK, { type: "finish", actor: "a", data: {} });
    const log = readEvents(dir, TASK);
    assert.equal(headHash(log), sha256(log.lines[1]));
    assert.equal(headHash(log.events), sha256(log.lines[1]));
  });
});

test("a partial trailing line is reported and ignored, and the rest verifies", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "stage-start", actor: "a", data: { stage: "build" } });
    appendEvent(dir, TASK, { type: "attempt", actor: "a", data: {} });
    const partial = '{"seq":2,"taskId":"task-1","type":"stage-com';
    appendFileSync(logPath(dir), partial);

    const log = readEvents(dir, TASK);
    assert.equal(log.lines.length, 2, "the torn line is not a complete line");
    assert.equal(log.events.length, 2);
    assert.equal(log.partialTail, partial, "the torn line is reported verbatim");
    assert.deepEqual(verifyChain(log), { ok: true });
    assert.equal(foldState(log).count, 2, "folding ignores the torn line");
  });
});

test("appendEvent drops a torn final line before appending", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "stage-start", actor: "a", data: { stage: "build" } });
    appendFileSync(logPath(dir), '{"seq":1,"torn":');
    appendEvent(dir, TASK, { type: "stage-complete", actor: "a", data: { to: "test" } });

    const log = readEvents(dir, TASK);
    assert.equal(log.partialTail, null);
    assert.equal(log.events.length, 2);
    assert.equal(log.events[1].prev, sha256(log.lines[0]));
    assert.deepEqual(verifyChain(log), { ok: true });
  });
});

test("editing any byte of an earlier line makes verifyChain fail naming that line", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "start", actor: "a", data: {} });
    appendEvent(dir, TASK, { type: "attempt", actor: "a", data: {} });
    appendEvent(dir, TASK, { type: "finish", actor: "a", data: {} });

    const { lines } = readEvents(dir, TASK);
    const edited = lines.slice();
    edited[1] = edited[1].replace('"type":"attempt"', '"type":"attempted"');
    assert.notEqual(edited[1], lines[1], "the middle line must actually change");
    writeFileSync(logPath(dir), `${edited.join("\n")}\n`);

    const result = verifyChain(readEvents(dir, TASK));
    assert.equal(result.ok, false, "a byte edit breaks the chain");
    assert.equal(result.line, 2, "the edited line is named");
  });

  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "start", actor: "a", data: {} });
    appendEvent(dir, TASK, { type: "finish", actor: "a", data: {} });

    const { lines } = readEvents(dir, TASK);
    const edited = lines.slice();
    edited[0] = edited[0].replace('"type":"start"', '"type":"restart"');
    writeFileSync(logPath(dir), `${edited.join("\n")}\n`);

    const result = verifyChain(readEvents(dir, TASK));
    assert.equal(result.ok, false);
    assert.equal(result.line, 1, "editing the first line is named too");
  });
});

test("deleting a middle line makes verifyChain fail", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "start", actor: "a", data: {} });
    appendEvent(dir, TASK, { type: "attempt", actor: "a", data: {} });
    appendEvent(dir, TASK, { type: "finish", actor: "a", data: {} });

    const { lines } = readEvents(dir, TASK);
    writeFileSync(logPath(dir), `${[lines[0], lines[2]].join("\n")}\n`);

    const result = verifyChain(readEvents(dir, TASK));
    assert.equal(result.ok, false, "a gap in seq breaks the chain");
    assert.equal(result.line, 2);
  });
});

test("an unparseable earlier line makes verifyChain fail naming it", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "start", actor: "a", data: {} });
    appendEvent(dir, TASK, { type: "finish", actor: "a", data: {} });

    const { lines } = readEvents(dir, TASK);
    writeFileSync(logPath(dir), `${lines[0]}\nnot json\n`);

    const log = readEvents(dir, TASK);
    assert.equal(log.events[1], null, "the unparseable line is not an event");
    const result = verifyChain(log);
    assert.equal(result.ok, false);
    assert.equal(result.line, 2);
  });
});

test("a fully rewritten log with a recomputed chain fails verifyAgainstHead with the old head", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "start", actor: "a", data: {} });
    appendEvent(dir, TASK, { type: "attempt", actor: "a", data: {} });
    appendEvent(dir, TASK, { type: "finish", actor: "a", data: {} });
    const oldHead = headHash(readEvents(dir, TASK));

    await withTempDir(async (other) => {
      appendEvent(other, TASK, { type: "start", actor: "b", data: {} });
      appendEvent(other, TASK, { type: "attempt", actor: "b", data: {} });
      appendEvent(other, TASK, { type: "finish", actor: "b", data: {} });
      const rewritten = readFileSync(logPath(other), "utf8");
      writeFileSync(logPath(dir), rewritten);
    });

    const log = readEvents(dir, TASK);
    assert.deepEqual(
      verifyChain(log),
      { ok: true },
      "the rewritten chain is internally consistent",
    );
    assert.notEqual(headHash(log), oldHead, "but its head is different");
    assert.equal(verifyAgainstHead(log, oldHead).ok, false, "the old head is no longer anchored");
    assert.deepEqual(verifyAgainstHead(log, headHash(log)), { ok: true });
  });
});

test("foldState takes the latest stage, preferring stage over to within one event", async () => {
  await withTempDir(async (dir) => {
    appendEvent(dir, TASK, { type: "s", actor: "a", data: { stage: "build", to: "ignored" } });
    assert.equal(
      foldState(readEvents(dir, TASK)).stage,
      "build",
      "stage wins over a co-located to",
    );
    appendEvent(dir, TASK, { type: "s", actor: "a", data: { to: "test" } });
    assert.equal(foldState(readEvents(dir, TASK)).stage, "test", "the latest transition wins");
    appendEvent(dir, TASK, { type: "s", actor: "a", data: { to: "review" } });
    assert.equal(foldState(readEvents(dir, TASK)).stage, "review", "the latest transition wins");
  });
});

test("verifyChain rejects a malformed input shape", () => {
  const result = verifyChain("not a log");
  assert.equal(result.ok, false);
});
