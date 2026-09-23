import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeRuntime } from "../scripts/adapters/fake.js";
import { assertRuntime, implementsRuntime, loadAdapter } from "../scripts/lifecycle/runtime.js";

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-runtime-"));
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

function initGitRepo(dir) {
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "yukl-test@example.invalid"],
    ["config", "user.name", "Yukl Test"],
  ]) {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// interface
// ---------------------------------------------------------------------------

test("assertRuntime accepts an object implementing the interface", () => {
  const runtime = createFakeRuntime();
  assert.equal(implementsRuntime(runtime), true);
  assert.equal(assertRuntime(runtime), runtime);
});

test("assertRuntime rejects an object missing a method or a value", () => {
  const missingResult = { start() {}, status() {}, stop() {} };
  assert.equal(implementsRuntime(missingResult), false);
  assert.throws(() => assertRuntime(missingResult), /result/);

  for (const bad of [null, undefined, "runtime", 42, { start() {} }]) {
    assert.equal(implementsRuntime(bad), false);
  }
});

// ---------------------------------------------------------------------------
// loadAdapter
// ---------------------------------------------------------------------------

test("loadAdapter imports a bundled adapter module", async () => {
  const mod = await loadAdapter("fake");
  assert.equal(typeof mod.createFakeRuntime, "function");
  assertRuntime(mod.createFakeRuntime({ script: [] }));
});

for (const bad of ["../x", "Upper", "a/b", "nosuch!", "-x", ""]) {
  test(`loadAdapter refuses "${bad}" without importing`, async () => {
    await assert.rejects(() => loadAdapter(bad), /not a valid adapter name/);
  });
}

test("loadAdapter refuses before importing even when the adapter is absent", async () => {
  await assert.rejects(
    () => loadAdapter("../fake", { adaptersDir: join(tmpdir(), "definitely-absent-adapters") }),
    /not a valid adapter name/,
  );
});

// ---------------------------------------------------------------------------
// fake adapter control
// ---------------------------------------------------------------------------

test("the fake adapter replays start/status/result and records the dispatch env", async () => {
  await withTempDir(async (dir) => {
    const runtime = createFakeRuntime({
      script: [{ files: { "nested/out.txt": "hello" }, exitCode: 0 }],
    });
    const handle = runtime.start({
      stage: "expert-power-drafter",
      taskId: "v2-w1-runtime",
      spec: "write the contract",
      worktree: dir,
      env: { YUKL_DISPATCH_ID: "ctx_demo_123" },
    });

    assert.equal(runtime.startCount, 1);
    assert.equal(runtime.status(handle), "exited");
    assert.equal(readFileSync(join(dir, "nested", "out.txt"), "utf8"), "hello");

    const outcome = runtime.result(handle);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.env.YUKL_DISPATCH_ID, "ctx_demo_123");
    assert.equal(runtime.starts[0].env.YUKL_DISPATCH_ID, "ctx_demo_123");
  });
});

test("a live handle reports live, a foreign handle is unverifiable, stop exits a live handle", () => {
  const runtime = createFakeRuntime({ script: [{}] });
  const handle = runtime.start({ worktree: process.cwd(), env: {} });
  assert.equal(runtime.status(handle), "live");
  assert.equal(runtime.status({ id: "not-mine" }), "unverifiable");
  assert.equal(runtime.result({ id: "not-mine" }), null);
  runtime.stop(handle);
  assert.equal(runtime.status(handle), "exited");
});

test("the fake adapter advances through the script one step per start", () => {
  const runtime = createFakeRuntime({ script: [{ exitCode: 0 }, { exitCode: 3 }] });
  const first = runtime.start({ worktree: process.cwd(), env: {} });
  const second = runtime.start({ worktree: process.cwd(), env: {} });
  assert.equal(runtime.startCount, 2);
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 3);
});

test("a script step writes files and commits in the worktree", async () => {
  await withTempDir(async (dir) => {
    initGitRepo(dir);
    const runtime = createFakeRuntime({
      script: [{ files: { "artifact.md": "done" }, commit: "fake stage output", exitCode: 0 }],
    });
    const handle = runtime.start({ worktree: dir, env: { YUKL_DISPATCH_ID: "ctx_commit" } });
    assert.equal(runtime.status(handle), "exited");
    assert.ok(existsSync(join(dir, "artifact.md")));

    const log = spawnSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf8" });
    assert.equal(log.status, 0);
    assert.match(log.stdout, /fake stage output/);

    const status = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    assert.equal(status.stdout.trim(), "", "the worktree is clean after the commit");
  });
});
