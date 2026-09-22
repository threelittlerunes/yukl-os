import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOT,
  checkScope,
  checkScopeWithoutContracts,
  contractViolations,
  dirtyTreeWarning,
  renderStage,
  runVerify,
} from "../scripts/yukl.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-verify-"));
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

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

test("render substitutes {out}, {reads} and <task_id> for expert-power-drafter", () => {
  const result = renderStage(join(ROOT, "flow.config.json"), "expert-power-drafter", "demo");
  assert.equal(result.ok, true, result.error);
  assert.ok(result.spec.includes(".orchestration/contracts/demo.json"));
  assert.ok(result.spec.includes(".orchestration/artifacts/scope_contract.md"));
  assert.ok(!/[{}]/.test(result.spec), "no {placeholders} may remain");
  assert.ok(!result.spec.includes("<task_id>"), "no <task_id> may remain");
});

test("render works for review.config.json", () => {
  const result = renderStage(join(ROOT, "review.config.json"), "review-consensus");
  assert.equal(result.ok, true, result.error);
  assert.ok(result.spec.includes(".orchestration/artifacts/review-a.md"));
  assert.ok(result.spec.includes(".orchestration/artifacts/review-b.md"));
  assert.ok(result.spec.includes(".orchestration/artifacts/review-consensus.md"));
});

test("render fails on an unknown stage id", () => {
  const result = renderStage(join(ROOT, "flow.config.json"), "no-such-stage");
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown stage id/);
});

test("render fails when a <task_id> is needed but --task-id is missing", () => {
  const result = renderStage(join(ROOT, "flow.config.json"), "expert-power-drafter");
  assert.equal(result.ok, false);
  assert.match(result.error, /--task-id is missing/);
});

test("render CLI exits 2 with a clear message for an unknown stage", () => {
  const result = spawnSync(process.execPath, ["scripts/yukl.js", "render", "bogus-stage"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown stage id/);
});

test("render CLI exits 2 when --task-id is missing", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/yukl.js", "render", "expert-power-drafter"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--task-id is missing/);
});

test("render CLI prints the substituted spec to stdout", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/yukl.js", "render", "expert-power-drafter", "--task-id", "demo"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(".orchestration/contracts/demo.json"));
  assert.ok(!result.stdout.includes("<task_id>"));
});

// ---------------------------------------------------------------------------
// verify: contract schema
// ---------------------------------------------------------------------------

test("contractViolations accepts a valid contract", () => {
  const data = {
    task_id: "t",
    empirical_proof: [{ command: "node --version", expected_exit_code: 0 }],
    files_touched: ["README.md"],
  };
  assert.deepEqual(contractViolations(".orchestration/contracts/t.json", data), []);
});

test("contractViolations rejects a non-zero expected_exit_code", () => {
  const data = {
    task_id: "t",
    empirical_proof: [{ command: "npm run test", expected_exit_code: 1 }],
    files_touched: ["README.md"],
  };
  const violations = contractViolations(".orchestration/contracts/t.json", data);
  assert.ok(violations.some((v) => /expected_exit_code must be 0/.test(v)));
});

test("verify fails on a malformed contract schema", async () => {
  const result = await runVerify({
    contractPaths: [join(FIXTURES, "contract-badschema.json")],
    allowlist: [],
    cwd: ROOT,
  });
  assert.equal(result.ok, false);
  const schemaCheck = result.checks.find((c) => c.name.includes("schema"));
  assert.equal(schemaCheck.status, "FAIL");
  assert.match(schemaCheck.detail, /empirical_proof must be a non-empty array/);
});

test("verify fails when task_id does not match the filename stem", async () => {
  const result = await runVerify({
    contractPaths: [join(FIXTURES, "contract-mismatch.json")],
    allowlist: ['node -e "process.exit(0)"'],
    cwd: ROOT,
  });
  assert.equal(result.ok, false);
  const schemaCheck = result.checks.find((c) => c.name.includes("schema"));
  assert.equal(schemaCheck.status, "FAIL");
  assert.match(schemaCheck.detail, /does not match the filename stem/);
});

// ---------------------------------------------------------------------------
// verify: allowlist and execution
// ---------------------------------------------------------------------------

test("verify passes a known-good contract with allowlisted commands", async () => {
  await withTempDir(async (dir) => {
    const result = await runVerify({
      contractPaths: [join(FIXTURES, "contract-good.json")],
      allowlist: ['node -e "process.exit(0)"'],
      cwd: dir,
    });
    assert.equal(result.ok, true);
    assert.ok(result.checks.every((c) => c.status === "PASS"));
  });
});

test("verify fails when an allowlisted command actually exits non-zero", async () => {
  await withTempDir(async (dir) => {
    const result = await runVerify({
      contractPaths: [join(FIXTURES, "contract-bad-exit.json")],
      allowlist: ['node -e "process.exit(3)"'],
      cwd: dir,
    });
    assert.equal(result.ok, false);
    const commandCheck = result.checks.find((c) => c.name.startsWith("command "));
    assert.equal(commandCheck.status, "FAIL");
    assert.match(commandCheck.detail, /expected exit 0, got 3/);
  });
});

test("verify treats a non-zero expected_exit_code as a schema failure and does not execute", async () => {
  await withTempDir(async (dir) => {
    const result = await runVerify({
      contractPaths: [join(FIXTURES, "contract-nonzero-expected.json")],
      allowlist: ['node -e "process.exit(0)"'],
      cwd: dir,
    });
    assert.equal(result.ok, false);
    const schemaCheck = result.checks.find((c) => c.name.includes("schema"));
    assert.equal(schemaCheck.status, "FAIL");
    assert.match(schemaCheck.detail, /expected_exit_code must be 0 \(CLAUDE\.md section 3\)/);
    assert.ok(
      !result.checks.some((c) => c.name.startsWith("command ")),
      "a schema-invalid command must never be executed",
    );
  });
});

test("verify fails on a non-allowlisted command without executing it", async () => {
  await withTempDir(async (dir) => {
    const result = await runVerify({
      contractPaths: [join(FIXTURES, "contract-notallowed.json")],
      allowlist: ['node -e "process.exit(0)"'],
      cwd: dir,
    });
    assert.equal(result.ok, false);
    const allowCheck = result.checks.find((c) => c.name.startsWith("allowlist "));
    assert.equal(allowCheck.status, "FAIL");
    assert.ok(
      !result.checks.some((c) => c.name.startsWith("command ")),
      "a non-allowlisted command must never be executed",
    );
    assert.equal(
      existsSync(join(dir, "marker.txt")),
      false,
      "the non-allowlisted command must not have run",
    );
  });
});

test("verify fails with a timeout when a proof command hangs", async () => {
  const started = Date.now();
  await withTempDir(async (dir) => {
    const hang = 'node -e "setTimeout(()=>{},60000)"';
    writeFileSync(
      join(dir, "contract-hang.json"),
      JSON.stringify({
        task_id: "contract-hang",
        empirical_proof: [{ command: hang, expected_exit_code: 0 }],
        files_touched: ["scripts/hang.js"],
      }),
    );
    const result = await runVerify({
      contractPaths: ["contract-hang.json"],
      allowlist: [hang],
      timeoutMs: 500,
      cwd: dir,
    });
    assert.equal(result.ok, false);
    const commandCheck = result.checks.find((c) => c.name.startsWith("command "));
    assert.equal(commandCheck.status, "FAIL");
    assert.match(commandCheck.detail, /timed out after 500 ms/);
  });
  assert.ok(Date.now() - started < 10000, "the timeout test must finish in under 10 s");
});

// ---------------------------------------------------------------------------
// verify: working-tree warning (B3 defect 3)
// ---------------------------------------------------------------------------

test("dirtyTreeWarning returns a warning for a non-empty porcelain string", () => {
  assert.match(dirtyTreeWarning("M scripts/yukl.js"), /uncommitted or untracked changes/);
});

test("dirtyTreeWarning returns none for an empty porcelain string", () => {
  assert.equal(dirtyTreeWarning(""), null);
});

test("dirtyTreeWarning ignores paths under node_modules/", () => {
  assert.equal(dirtyTreeWarning("?? node_modules/foo.js"), null);
});

test("verify --base records WARN, not FAIL, on a dirty working tree (injected porcelain)", async () => {
  const result = await runVerify({
    contractPaths: [],
    base: "main",
    allowlist: [],
    diffFiles: ["docs/SDLC_PLAN.md"],
    porcelain: "M CONTRIBUTING.md\n?? scripts/scratch.js",
    cwd: ROOT,
  });
  assert.equal(result.ok, true, "a dirty working tree must not fail the preview");
  const warnCheck = result.checks.find((c) => c.name === "working tree clean");
  assert.equal(warnCheck.status, "WARN");
  assert.match(warnCheck.detail, /checks committed state only/);
});

// ---------------------------------------------------------------------------
// verify: scope rules (pure function)
// ---------------------------------------------------------------------------

test("checkScope passes when every changed file is covered by a verified contract", () => {
  const diff = ["docs/SDLC_PLAN.md", "src/ui/button.js", ".orchestration/contracts/task-x.json"];
  const contracts = [
    {
      path: ".orchestration/contracts/task-x.json",
      task_id: "task-x",
      files_touched: ["docs/SDLC_PLAN.md", "src/ui/button.js"],
    },
  ];
  const scope = checkScope(diff, contracts);
  assert.deepEqual(scope.uncovered, []);
  assert.equal(scope.codeWithoutContract, false);
});

test("checkScope flags changed files not listed in any verified contract", () => {
  const diff = ["docs/SDLC_PLAN.md", "src/ui/button.js", ".orchestration/contracts/task-x.json"];
  const contracts = [
    {
      path: ".orchestration/contracts/task-x.json",
      task_id: "task-x",
      files_touched: ["docs/SDLC_PLAN.md"],
    },
  ];
  const scope = checkScope(diff, contracts);
  assert.deepEqual(scope.uncovered, ["src/ui/button.js"]);
  assert.equal(scope.codeWithoutContract, false);
});

test("checkScope flags a code change without a contract file in the diff", () => {
  const scope = checkScope(["src/ui/button.js"], []);
  assert.deepEqual(scope.uncovered, ["src/ui/button.js"]);
  assert.equal(scope.codeWithoutContract, true);
});

test("checkScope ignores contract files themselves", () => {
  const scope = checkScope([".orchestration/contracts/task-x.json"], []);
  assert.deepEqual(scope.uncovered, []);
  assert.equal(scope.codeWithoutContract, false);
});

test("checkScope treats docs-only diffs as code-safe but still requires coverage", () => {
  const scope = checkScope(["docs/SDLC_PLAN.md", "README.md"], []);
  assert.equal(scope.codeWithoutContract, false);
  assert.deepEqual(scope.uncovered, ["docs/SDLC_PLAN.md", "README.md"]);
});

// ---------------------------------------------------------------------------
// verify: docs-only diffs without contracts (B2 defect 1)
// ---------------------------------------------------------------------------

test("checkScopeWithoutContracts passes a docs-only diff", () => {
  const scope = checkScopeWithoutContracts(["docs/SDLC_PLAN.md", "README.md"]);
  assert.deepEqual(scope.violations, []);
});

test("checkScopeWithoutContracts fails a non-doc file with no contract", () => {
  const scope = checkScopeWithoutContracts(["scripts/foo.js"]);
  assert.deepEqual(scope.violations, ["scripts/foo.js"]);
});

test("verify passes a docs-only diff with no contract files (injected diff)", async () => {
  const result = await runVerify({
    contractPaths: [],
    base: "main",
    allowlist: [],
    diffFiles: ["docs/SDLC_PLAN.md", "README.md", "CONTRIBUTING.md"],
    porcelain: "",
    cwd: ROOT,
  });
  assert.equal(result.ok, true);
  assert.ok(result.checks.every((c) => c.status === "PASS"));
});

test("verify fails a code diff with no contract files (injected diff)", async () => {
  const result = await runVerify({
    contractPaths: [],
    base: "main",
    allowlist: [],
    diffFiles: ["scripts/foo.js"],
    porcelain: "",
    cwd: ROOT,
  });
  assert.equal(result.ok, false);
  const scopeCheck = result.checks.find((c) => c.name.startsWith("scope"));
  assert.equal(scopeCheck.status, "FAIL");
  assert.match(scopeCheck.detail, /scripts\/foo\.js/);
});

test("verify still fails on zero contracts without --base", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, ".orchestration", "contracts"), { recursive: true });
    const result = await runVerify({ contractPaths: [], allowlist: [], cwd: dir });
    assert.equal(result.ok, false);
    assert.ok(result.checks.some((c) => /no contract files/.test(c.detail)));
  });
});
