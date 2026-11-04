// Finding Y2: the audit stage passes on its committed verdict, not on the
// auditor's exit code (cloud-y2-audit-verdict). Every test drives the real
// engine, event log, stage machine and verdict reader against a throwaway git
// repository; only the auditor process is a stub that exits 0.
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../scripts/commands/run.js";
import { step } from "../scripts/lifecycle/engine.js";
import { appendEvent, headHash, readEvents } from "../scripts/lifecycle/events.js";
import * as stages from "../scripts/lifecycle/stages.js";
import { VERDICTS_DIR, readVerdictAt } from "../scripts/lifecycle/verdict.js";

const TASK = "task-audit";
const RUNTIME_ID = "stub-auditor";
const SEED_COMMIT = "a".repeat(40);
const TO_AUDIT = [
  ["intent", "scope"],
  ["scope", "plan"],
  ["plan", "implement"],
  ["implement", "prove"],
  ["prove", "audit"],
];

function git(args, cwd) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Yukl Test", "-c", "user.email=", ...args],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repository and a log directory, removed afterwards. */
async function withRepo(fn) {
  const root = mkdtempSync(join(tmpdir(), "yukl-audit-verdict-"));
  const repo = join(root, "repo");
  const logs = join(root, "logs");
  mkdirSync(repo);
  mkdirSync(logs);
  try {
    git(["init", "-q"], repo);
    writeFileSync(join(repo, "README.md"), "seed\n");
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "seed"], repo);
    return await fn({ repo, logs });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Commit `text` as the task's verdict and return the commit. */
function commitVerdict(repo, text) {
  mkdirSync(join(repo, VERDICTS_DIR), { recursive: true });
  writeFileSync(join(repo, VERDICTS_DIR, `${TASK}.json`), text);
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "audit verdict"], repo);
  return git(["rev-parse", "HEAD"], repo);
}

/** Seed the log so the lifecycle stands at `stage`, with implement done by `implementer`. */
function seedTo(logs, pairs, implementer = "agent-implement") {
  for (const [stage, to] of pairs) {
    appendEvent(logs, TASK, {
      type: "stage_done",
      actor: stage === "implement" ? implementer : `agent-${stage}`,
      anchor: { path: `${stage}.md`, commit: SEED_COMMIT },
      data: { stage, to },
    });
  }
}

/** An auditor that always exits 0, whatever its verdict says. */
function exitZeroRuntime() {
  let starts = 0;
  return {
    name: RUNTIME_ID,
    start({ stage }) {
      starts += 1;
      return `handle-${stage}-${starts}`;
    },
    status: () => "exited",
    result: () => ({ exitCode: 0 }),
    stop() {},
  };
}

/**
 * The engine environment. `anchorCommit()` names the commit the audit anchors
 * at; the verdict reader is the real one, reading at that commit.
 */
function makeDeps({ repo, logs, anchorCommit, overrides = {} }) {
  const runtime = exitZeroRuntime();
  return {
    events: { dir: logs, readEvents, appendEvent, headHash },
    stages,
    anchors: {
      anchorStage: (stage) => ({
        ok: true,
        anchor: { path: `${VERDICTS_DIR}/${TASK}.json`, commit: anchorCommit(stage) },
      }),
    },
    verdicts: {
      read: ({ taskId, anchor }) => readVerdictAt({ cwd: repo, taskId, commit: anchor.commit }),
    },
    requiresHuman: () => false,
    runtime: () => runtime,
    runtimeId: () => RUNTIME_ID,
    enforce: () => ({ ok: true, violations: [] }),
    decide: () => ({ kind: "retry" }),
    vcs: { merge: async () => ({ ok: true, sha: "b".repeat(40) }) },
    dispatch: (stage) => ({ actor: `agent-${stage}` }),
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** Start the stage the log stands at, then judge it once the stub has exited. */
async function startAndJudge(deps) {
  const started = await step({ taskId: TASK, deps });
  assert.equal(started.status, "started", "the stage must start first");
  return step({ taskId: TASK, deps });
}

function eventsOf(logs, type) {
  return readEvents(logs, TASK).events.filter((event) => event.type === type);
}

function advancedFromAudit(logs) {
  return eventsOf(logs, "stage_done").filter((event) => event.data.stage === "audit");
}

test("a pass verdict advances audit and appends one audit_verdict pass", async () => {
  await withRepo(async ({ repo, logs }) => {
    const sha = commitVerdict(repo, JSON.stringify({ verdict: "pass", reasons: ["proof ok"] }));
    seedTo(logs, TO_AUDIT);
    const outcome = await startAndJudge(makeDeps({ repo, logs, anchorCommit: () => sha }));

    assert.equal(outcome.status, "advanced");
    assert.equal(outcome.from, "audit");
    assert.equal(outcome.to, "review");
    const verdicts = eventsOf(logs, "audit_verdict");
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0].data.verdict, "pass");
    assert.equal(verdicts[0].data.runtime, RUNTIME_ID);
    assert.equal(verdicts[0].data.commit, sha);
    assert.deepEqual(verdicts[0].data.reasons, ["proof ok"]);
    assert.equal(advancedFromAudit(logs).length, 1);
  });
});

test("a fail verdict with exit code 0 does not advance audit and appends one audit_verdict fail", async () => {
  await withRepo(async ({ repo, logs }) => {
    const sha = commitVerdict(repo, JSON.stringify({ verdict: "fail", reasons: ["proof red"] }));
    seedTo(logs, TO_AUDIT);
    const outcome = await startAndJudge(makeDeps({ repo, logs, anchorCommit: () => sha }));

    assert.equal(outcome.status, "failed", "a fail verdict fails the stage despite exit 0");
    assert.equal(outcome.stage, "audit");
    assert.equal(advancedFromAudit(logs).length, 0, "nothing advances audit");
    const verdicts = eventsOf(logs, "audit_verdict");
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0].data.verdict, "fail");
    assert.equal(verdicts[0].data.runtime, RUNTIME_ID);

    const failed = eventsOf(logs, "stage_failed");
    assert.equal(failed.length, 1, "the fail goes through the existing failure path");
    assert.equal(failed[0].data.stage, "audit");
    assert.equal(failed[0].data.observation.exitCode, 0);
    assert.equal(failed[0].data.observation.verdict, "fail");
    assert.equal(failed[0].data.observation.proofFailed, true);
    assert.deepEqual(failed[0].data.observation.reasons, ["proof red"]);
    assert.equal(eventsOf(logs, "decision").length, 1, "diagnosis runs once, as for any failure");
  });
});

test("a missing verdict blocks audit with R-NO-VERDICT and appends no audit_verdict", async () => {
  await withRepo(async ({ repo, logs }) => {
    const head = git(["rev-parse", "HEAD"], repo);
    seedTo(logs, TO_AUDIT);
    const outcome = await startAndJudge(makeDeps({ repo, logs, anchorCommit: () => head }));

    assert.equal(outcome.status, "blocked");
    assert.equal(outcome.rule, stages.R_NO_VERDICT);
    assert.equal(outcome.rule, "R-NO-VERDICT");
    assert.match(outcome.detail, /no verdict/);
    assert.equal(eventsOf(logs, "audit_verdict").length, 0);
    assert.equal(advancedFromAudit(logs).length, 0);
    assert.equal(eventsOf(logs, "stage_failed").length, 0, "a missing verdict is not a failure");
  });
});

test("a malformed verdict blocks audit with R-NO-VERDICT and appends no audit_verdict", async () => {
  await withRepo(async ({ repo, logs }) => {
    const sha = commitVerdict(repo, JSON.stringify({ verdict: "PASS", reasons: [] }));
    seedTo(logs, TO_AUDIT);
    const outcome = await startAndJudge(makeDeps({ repo, logs, anchorCommit: () => sha }));

    assert.equal(outcome.status, "blocked");
    assert.equal(outcome.rule, "R-NO-VERDICT");
    assert.equal(eventsOf(logs, "audit_verdict").length, 0);
    assert.equal(advancedFromAudit(logs).length, 0);
  });
});

test("a reader that cannot read the verdict blocks with R-NO-VERDICT", async () => {
  await withRepo(async ({ repo, logs }) => {
    const sha = commitVerdict(repo, JSON.stringify({ verdict: "pass", reasons: [] }));
    seedTo(logs, TO_AUDIT);
    const deps = makeDeps({
      repo,
      logs,
      anchorCommit: () => sha,
      overrides: { verdicts: { read: () => ({ ok: false, error: "git show failed" }) } },
    });
    const outcome = await startAndJudge(deps);

    assert.equal(outcome.status, "blocked");
    assert.equal(outcome.rule, "R-NO-VERDICT");
    assert.equal(outcome.detail, "git show failed");
    assert.equal(eventsOf(logs, "audit_verdict").length, 0);
    assert.equal(advancedFromAudit(logs).length, 0);
  });
});

test("a reader that returns neither pass nor fail blocks with R-NO-VERDICT", async () => {
  await withRepo(async ({ repo, logs }) => {
    const head = git(["rev-parse", "HEAD"], repo);
    seedTo(logs, TO_AUDIT);
    const deps = makeDeps({
      repo,
      logs,
      anchorCommit: () => head,
      overrides: { verdicts: { read: () => ({ ok: true, verdict: "approved", reasons: [] }) } },
    });
    const outcome = await startAndJudge(deps);

    assert.equal(outcome.status, "blocked");
    assert.equal(outcome.rule, "R-NO-VERDICT");
    assert.equal(eventsOf(logs, "audit_verdict").length, 0);
  });
});

test("a retry that finds the verdict an earlier attempt judged blocks with R-NO-VERDICT", async () => {
  await withRepo(async ({ repo, logs }) => {
    const sha = commitVerdict(repo, JSON.stringify({ verdict: "fail", reasons: [] }));
    seedTo(logs, TO_AUDIT);
    const deps = makeDeps({ repo, logs, anchorCommit: () => sha });
    assert.equal((await startAndJudge(deps)).status, "failed");

    // The retry anchors at the same commit: the auditor committed no new verdict.
    const retry = await startAndJudge(deps);
    assert.equal(retry.status, "blocked");
    assert.equal(retry.rule, "R-NO-VERDICT");
    assert.match(retry.detail, /already judged/);
    assert.equal(eventsOf(logs, "audit_verdict").length, 1, "a consumed verdict counts once");
    assert.equal(advancedFromAudit(logs).length, 0);
  });
});

test("a blocked audit that is stepped again reuses its recorded verdict and records it once", async () => {
  await withRepo(async ({ repo, logs }) => {
    const sha = commitVerdict(repo, JSON.stringify({ verdict: "pass", reasons: [] }));
    seedTo(logs, TO_AUDIT);
    const deps = makeDeps({
      repo,
      logs,
      anchorCommit: () => sha,
      overrides: { requiresHuman: (id) => id === "advance:audit->review" },
    });
    const first = await startAndJudge(deps);
    assert.equal(first.status, "blocked");
    assert.equal(first.rule, "R-NEEDS-HUMAN");

    const again = await step({ taskId: TASK, deps });
    assert.equal(again.status, "blocked");
    assert.equal(again.rule, "R-NEEDS-HUMAN", "the reused verdict still reaches the policy");
    assert.equal(eventsOf(logs, "audit_verdict").length, 1);
  });
});

test("a pass verdict from the implementing agent is still refused as self-approval", async () => {
  await withRepo(async ({ repo, logs }) => {
    const sha = commitVerdict(repo, JSON.stringify({ verdict: "pass", reasons: [] }));
    seedTo(logs, TO_AUDIT, "agent-audit");
    const outcome = await startAndJudge(makeDeps({ repo, logs, anchorCommit: () => sha }));

    assert.equal(outcome.status, "blocked");
    assert.equal(outcome.rule, "R-SELF-APPROVAL");
    assert.equal(advancedFromAudit(logs).length, 0);
  });
});

test("enforcement still refuses an audit before its verdict is read", async () => {
  await withRepo(async ({ repo, logs }) => {
    const sha = commitVerdict(repo, JSON.stringify({ verdict: "pass", reasons: [] }));
    seedTo(logs, TO_AUDIT);
    const deps = makeDeps({
      repo,
      logs,
      anchorCommit: () => sha,
      overrides: { enforce: () => ({ ok: false, rule: "R-PATH-SCOPE", violations: ["x"] }) },
    });
    const outcome = await startAndJudge(deps);

    assert.equal(outcome.status, "enforced");
    assert.equal(outcome.rule, "R-PATH-SCOPE");
    assert.equal(eventsOf(logs, "audit_verdict").length, 0, "no verdict is read once enforced");
  });
});

test("the review stage still completes on its exit code and reads no verdict", async () => {
  await withRepo(async ({ repo, logs }) => {
    const head = git(["rev-parse", "HEAD"], repo);
    seedTo(logs, [...TO_AUDIT, ["audit", "review"]]);
    let reads = 0;
    const deps = makeDeps({
      repo,
      logs,
      anchorCommit: () => head,
      overrides: {
        verdicts: {
          read: () => {
            reads += 1;
            return { ok: false, error: "must not be read" };
          },
        },
      },
    });
    const outcome = await startAndJudge(deps);

    assert.equal(outcome.status, "advanced");
    assert.equal(outcome.from, "review");
    assert.equal(outcome.to, "integrate");
    assert.equal(reads, 0, "only the audit stage reads a verdict");
    assert.equal(eventsOf(logs, "audit_verdict").length, 0);
  });
});

// ---------------------------------------------------------------------------
// yukl run: the audit anchors at the verdict commit and reads the real verdict
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// A runtime adapter that exits 0 as soon as it is polled and reports no
// workspace, so `yukl run` resolves the anchor in the orchestrator checkout.
// Its handles live in module scope, so they survive across two run() calls.
const EXIT_ZERO_ADAPTER = [
  "let count = 0;",
  "const started = new Set();",
  "export function createExitZeroRuntime() {",
  "  return {",
  "    start() {",
  "      count += 1;",
  "      const id = `audit-${count}`;",
  "      started.add(id);",
  "      return id;",
  "    },",
  '    status: (id) => (started.has(id) ? "exited" : "unverifiable"),',
  "    result: (id) => (started.has(id) ? { exitCode: 0 } : null),",
  "    stop() {},",
  "  };",
  "}",
].join("\n");

const PLACEHOLDER_VCS = [
  "export function createVcs() {",
  "  return {",
  "    checks: async () => ({ ok: false, results: [] }),",
  '    merge: async () => ({ ok: false, error: "placeholder adapter" }),',
  "  };",
  "}",
].join("\n");

/** A repository `yukl run` accepts, with the lifecycle standing at audit. */
function writeRunRepo(repo) {
  mkdirSync(join(repo, "scripts", "adapters"), { recursive: true });
  writeFileSync(join(repo, "scripts", "adapters", "exit-zero.js"), EXIT_ZERO_ADAPTER);
  writeFileSync(join(repo, "scripts", "adapters", "vcs-github.js"), PLACEHOLDER_VCS);
  const config = {
    version: 1,
    commands: { build: "npm run build", test: "npm run test", format: "npm run format" },
    folders: {
      contracts: ".orchestration/contracts",
      intents: ".orchestration/intents",
      locks: ".orchestration/locks",
      artifacts: ".orchestration/artifacts",
    },
    allowlist: ["npm run build", "npm run test"],
    lifecycle: {
      runtimes: { audit: { adapter: "exit-zero", agent: "auditor" } },
      vcs: "vcs-github",
      stateDir: ".orchestration/state",
    },
  };
  writeFileSync(join(repo, "yukl.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(
    join(repo, "yukl.policy.json"),
    readFileSync(join(ROOT, "yukl.policy.json"), "utf8"),
  );
  writeFileSync(join(repo, ".gitignore"), ".orchestration/state/\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "harness"], repo);
  const stateDir = join(repo, ".orchestration", "state");
  seedTo(stateDir, TO_AUDIT);
  return stateDir;
}

/** Commit the task's contract, so a contract anchor would name this later commit. */
function commitContract(repo) {
  mkdirSync(join(repo, ".orchestration", "contracts"), { recursive: true });
  writeFileSync(join(repo, ".orchestration", "contracts", `${TASK}.json`), "{}\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "contract"], repo);
  return git(["rev-parse", "HEAD"], repo);
}

/** Two attended steps: start the auditor, then judge it once it has exited. */
async function runAuditTwice(repo) {
  const log = console.log;
  const error = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    await run([TASK, "--once", "--cwd", repo]);
    await run([TASK, "--once", "--cwd", repo]);
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines.join("\n");
}

test("yukl run judges audit by the verdict at the last commit that touched it", async () => {
  await withRepo(async ({ repo }) => {
    const stateDir = writeRunRepo(repo);
    const verdictCommit = commitVerdict(
      repo,
      JSON.stringify({ verdict: "fail", reasons: ["red"] }),
    );
    const contractCommit = commitContract(repo);
    assert.notEqual(verdictCommit, contractCommit);

    const out = await runAuditTwice(repo);

    assert.match(out, /yukl run: failed at audit/);
    const verdicts = readEvents(stateDir, TASK).events.filter((e) => e.type === "audit_verdict");
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0].data.verdict, "fail");
    assert.equal(verdicts[0].data.runtime, "exit-zero", "the runtime id the track record counts");
    assert.equal(verdicts[0].data.commit, verdictCommit, "the audit anchors at the verdict commit");
    const done = readEvents(stateDir, TASK).events.filter(
      (e) => e.type === "stage_done" && e.data.stage === "audit",
    );
    assert.equal(done.length, 0, "a fail verdict with exit 0 does not advance audit");
  });
});

test("yukl run blocks an audit with no committed verdict with R-NO-VERDICT", async () => {
  await withRepo(async ({ repo }) => {
    const stateDir = writeRunRepo(repo);
    commitContract(repo);
    // An uncommitted pass verdict in the working tree must not count.
    mkdirSync(join(repo, VERDICTS_DIR), { recursive: true });
    writeFileSync(
      join(repo, VERDICTS_DIR, `${TASK}.json`),
      JSON.stringify({ verdict: "pass", reasons: [] }),
    );

    const out = await runAuditTwice(repo);

    assert.match(out, /yukl run: blocked at audit \(R-NO-VERDICT\)/);
    const events = readEvents(stateDir, TASK).events;
    assert.equal(events.filter((e) => e.type === "audit_verdict").length, 0);
    assert.equal(
      events.filter((e) => e.type === "stage_done" && e.data.stage === "audit").length,
      0,
    );
  });
});
