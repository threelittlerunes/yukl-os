import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUN_LIMIT_KEYS,
  loadPolicy,
  policyViolations,
  requiresHuman,
  unattendedAllowed,
} from "../scripts/lifecycle/policy.js";
import { validate } from "../scripts/validators/policy.js";
import { runInit } from "../scripts/yukl.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMITTED = JSON.parse(readFileSync(join(ROOT, "yukl.policy.json"), "utf8"));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function cleanup(dir) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err.code !== "EPERM" && err.code !== "EBUSY") throw err;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-policy-"));
  try {
    return await fn(dir);
  } finally {
    await cleanup(dir);
  }
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

async function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-policy-repo-"));
  try {
    git(["-c", "init.defaultBranch=main", "init", "-q"], dir);
    git(["config", "user.name", "Yukl Test"], dir);
    git(["config", "user.email", "yukl-test@example.com"], dir);
    return await fn(dir);
  } finally {
    await cleanup(dir);
  }
}

function writePolicy(dir, policy) {
  writeFileSync(join(dir, "yukl.policy.json"), JSON.stringify(policy, null, 2));
}

// ---------------------------------------------------------------------------
// schema (pure function)
// ---------------------------------------------------------------------------

test("policyViolations accepts the committed policy (known-good control)", () => {
  assert.deepEqual(policyViolations(COMMITTED), []);
});

test("policyViolations rejects a non-object root and an invalid autonomy value", () => {
  assert.ok(policyViolations(null).some((v) => /root must be a JSON object/.test(v)));
  const bad = clone(COMMITTED);
  bad.autonomy["merge-intent-pr"] = "sometimes";
  assert.ok(policyViolations(bad).some((v) => /autonomy\.merge-intent-pr must be/.test(v)));
});

test("policyViolations rejects a ceiling below zero and an auto_at_level below one", () => {
  const badCeiling = clone(COMMITTED);
  badCeiling.ceiling = -1;
  assert.ok(policyViolations(badCeiling).some((v) => /ceiling must be an integer >= 0/.test(v)));

  const badLevel = clone(COMMITTED);
  badLevel.autonomy["advance-stage-on-gate-pass"] = { auto_at_level: 0 };
  assert.ok(
    policyViolations(badLevel).some((v) =>
      /autonomy\.advance-stage-on-gate-pass\.auto_at_level must be an integer >= 1/.test(v),
    ),
  );
});

test("policyViolations rejects a bad maxAttemptsPerStage and a bad run limit", () => {
  const badAttempts = clone(COMMITTED);
  badAttempts.limits.maxAttemptsPerStage = 0;
  assert.ok(
    policyViolations(badAttempts).some((v) =>
      /limits\.maxAttemptsPerStage must be an integer >= 1/.test(v),
    ),
  );

  const badLimit = clone(COMMITTED);
  badLimit.budgets.maxWallMinutesPerRun = 0;
  assert.ok(
    policyViolations(badLimit).some((v) =>
      /budgets\.maxWallMinutesPerRun must be a positive integer or null/.test(v),
    ),
  );

  const missing = clone(COMMITTED);
  missing.budgets = { maxWallMinutesPerRun: 60 };
  assert.ok(
    policyViolations(missing).some((v) =>
      /budgets\.maxAgentStartsPerRun must be a positive integer or null/.test(v),
    ),
  );
});

test("policyViolations refuses maxTokensPerRun as a key that is not a run limit", () => {
  const withTokens = clone(COMMITTED);
  withTokens.budgets.maxTokensPerRun = 100000;
  const violations = policyViolations(withTokens);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /budgets\.maxTokensPerRun is not a run limit/);
  assert.match(violations[0], /maxWallMinutesPerRun and maxAgentStartsPerRun/);
  assert.deepEqual([...RUN_LIMIT_KEYS], ["maxWallMinutesPerRun", "maxAgentStartsPerRun"]);
});

test("policyViolations rejects a malformed trackRecord level", () => {
  const bad = clone(COMMITTED);
  bad.trackRecord.levels = [{ level: 1, minCleanRuns: "many" }];
  assert.ok(policyViolations(bad).some((v) => /trackRecord\.levels\[0\]\.minCleanRuns/.test(v)));
});

// ---------------------------------------------------------------------------
// requiresHuman (pure function)
// ---------------------------------------------------------------------------

test("requiresHuman maps human, auto and auto_at_level and fails closed", () => {
  const policy = {
    autonomy: {
      always: "human",
      never: "auto",
      gated: { auto_at_level: 2 },
    },
  };
  assert.equal(requiresHuman(policy, "always", 9), true);
  assert.equal(requiresHuman(policy, "never", 0), false);
  assert.equal(requiresHuman(policy, "gated", 1), true);
  assert.equal(requiresHuman(policy, "gated", 2), false);
  assert.equal(requiresHuman(policy, "unknown", 99), true);
  assert.equal(requiresHuman({}, "unknown"), true);
});

test("requiresHuman is true at level 0 for a transition marked auto_at_level 1", () => {
  const policy = { autonomy: { "advance-stage-on-gate-pass": { auto_at_level: 1 } } };
  assert.equal(requiresHuman(policy, "advance-stage-on-gate-pass", 0), true);
  assert.equal(requiresHuman(policy, "advance-stage-on-gate-pass", 1), false);
});

test("requiresHuman fails closed on a malformed autonomy value", () => {
  assert.equal(requiresHuman({ autonomy: { t: { auto_at_level: "soon" } } }, "t", 5), true);
  assert.equal(requiresHuman({ autonomy: { t: { auto_at_level: 2.5 } } }, "t", 5), true);
});

// ---------------------------------------------------------------------------
// unattendedAllowed (pure function)
// ---------------------------------------------------------------------------

test("unattendedAllowed is true only when every run limit is a positive integer", () => {
  const complete = { budgets: { maxWallMinutesPerRun: 60, maxAgentStartsPerRun: 4 } };
  assert.equal(unattendedAllowed(complete), true);

  for (const key of RUN_LIMIT_KEYS) {
    const budgets = { ...complete.budgets, [key]: null };
    assert.equal(unattendedAllowed({ budgets }), false, `${key} null must block unattended runs`);
    const zero = { ...complete.budgets, [key]: 0 };
    assert.equal(
      unattendedAllowed({ budgets: zero }),
      false,
      `${key} 0 must block unattended runs`,
    );
  }
});

test("unattendedAllowed is false for a policy with no run limits", () => {
  assert.equal(unattendedAllowed({}), false);
  assert.equal(unattendedAllowed({ budgets: {} }), false);
  assert.equal(unattendedAllowed({ budgets: { maxWallMinutesPerRun: null } }), false);
});

test("the committed policy ships the two run limits switched on", () => {
  assert.deepEqual(COMMITTED.budgets, {
    maxWallMinutesPerRun: 120,
    maxAgentStartsPerRun: 12,
  });
  assert.equal(unattendedAllowed(COMMITTED), true);
  assert.equal(Object.hasOwn(COMMITTED.budgets, "maxTokensPerRun"), false);
});

test("yukl init writes no policy, and any template that ships one carries the same limits", async () => {
  await withTempRepo(async (dir) => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node t.js" } }));
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    git(["checkout", "-q", "-b", "feature"], dir);

    const result = runInit({ cwd: dir, yuklPin: "deadbeef", checkPinReachable: () => true });
    assert.equal(result.ok, true, result.error);
    assert.equal(
      result.writes.includes("yukl.policy.json"),
      false,
      "yukl init installs no policy, so a repository keeps the one it has",
    );
    assert.equal(readdirSync(join(dir)).includes("yukl.policy.json"), false);
  });

  // The harness ships exactly one set of run limits (yukl.policy.json). A
  // template added later that writes a policy must ship the same ones.
  for (const name of readdirSync(join(ROOT, "templates"))) {
    if (!name.endsWith(".json")) continue;
    const doc = JSON.parse(readFileSync(join(ROOT, "templates", name), "utf8"));
    if (!Object.hasOwn(doc, "budgets")) continue;
    assert.deepEqual(
      doc.budgets,
      COMMITTED.budgets,
      `templates/${name} must ship the committed run limits`,
    );
  }
});

// ---------------------------------------------------------------------------
// validator plugin
// ---------------------------------------------------------------------------

test("the policy validator accepts the committed repository (known-good control)", () => {
  assert.deepEqual(validate(ROOT).errors, []);
});

test("the policy validator fails when auto_at_level is above the ceiling", async () => {
  await withTempDir(async (dir) => {
    const bad = clone(COMMITTED);
    bad.autonomy["advance-stage-on-gate-pass"] = { auto_at_level: 2 };
    writePolicy(dir, bad);
    const { errors } = validate(dir);
    assert.ok(
      errors.some((e) =>
        /autonomy\.advance-stage-on-gate-pass\.auto_at_level 2 is above ceiling 1/.test(e),
      ),
      `expected a ceiling violation, got: ${errors.join("; ")}`,
    );
  });
});

test("the policy validator reports an unreadable policy", async () => {
  await withTempDir(async (dir) => {
    const { errors } = validate(dir);
    assert.ok(errors.some((e) => /yukl\.policy\.json cannot be read/.test(e)));
  });
});

// ---------------------------------------------------------------------------
// loader: working tree preview and base ref
// ---------------------------------------------------------------------------

test("loadPolicy without base reads the working tree as a preview", () => {
  const { ok, policy, errors } = loadPolicy({ cwd: ROOT });
  assert.equal(ok, true, errors.join("; "));
  assert.equal(policy.ceiling, 1);
  assert.equal(policy.limits.maxAttemptsPerStage, 3);
  assert.equal(policy.autonomy["merge-intent-pr"], "human");
  assert.equal(policy.autonomy["merge-implementation-pr"], "auto");
});

test("loadPolicy reports a missing policy without base", async () => {
  await withTempDir(async (dir) => {
    const { ok, policy, errors } = loadPolicy({ cwd: dir });
    assert.equal(ok, false);
    assert.equal(policy, null);
    assert.ok(errors.some((e) => /cannot read yukl\.policy\.json/.test(e)));
  });
});

test("the committed policy validates and loads from the base ref (known-good control)", async () => {
  await withTempRepo(async (dir) => {
    writePolicy(dir, COMMITTED);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "policy"], dir);

    const { ok, policy, errors } = loadPolicy({ cwd: dir, base: "main" });
    assert.equal(ok, true, errors.join("; "));
    assert.equal(policy.ceiling, 1);
    assert.equal(policy.autonomy["merge-intent-pr"], "human");
  });
});

test("loadPolicy with base ignores a pull request that flips a human transition to auto", async () => {
  await withTempRepo(async (dir) => {
    writePolicy(dir, COMMITTED);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base policy"], dir);
    git(["checkout", "-q", "-b", "feature"], dir);

    const flipped = clone(COMMITTED);
    flipped.autonomy["merge-intent-pr"] = "auto";
    writePolicy(dir, flipped);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "widen autonomy"], dir);

    const fromBase = loadPolicy({ cwd: dir, base: "main" });
    assert.equal(fromBase.ok, true, fromBase.errors.join("; "));
    assert.equal(fromBase.policy.autonomy["merge-intent-pr"], "human");

    const preview = loadPolicy({ cwd: dir });
    assert.equal(preview.policy.autonomy["merge-intent-pr"], "auto");
  });
});
