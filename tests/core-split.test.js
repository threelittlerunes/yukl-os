import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const YUKL = join(ROOT, "scripts", "yukl.js");

const FLOW_CONFIG = {
  artifactsDir: ".orchestration/artifacts",
  maxRetries: 3,
  autoRun: true,
  defaults: { timeoutMs: 600000, worktree: null, readinessMinBytes: 200 },
  pipeline: [
    {
      id: "base-stage",
      title: "Base stage",
      enabled: true,
      agent: "claude",
      writes: "base-out.md",
      reads: [],
      spec: "base spec",
    },
  ],
};

const INTENT_YAML = [
  "intent:",
  '  goal: "A trivial foreign-repo contract."',
  "  scope:",
  "    allowed_paths:",
  '      - "flow.config.json"',
  '      - ".orchestration/contracts/*.json"',
  "rational_persuasion:",
  "  empirical_proof:",
  "    - command: 'node -e \"process.exit(0)\"'",
  "      expected_exit_code: 0",
  "consultation:",
  "  requires_human_approval: false",
  "",
].join("\n");

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

async function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yukl-core-"));
  try {
    git(["-c", "init.defaultBranch=main", "init", "-q"], dir);
    git(["config", "user.name", "Yukl Test"], dir);
    git(["config", "user.email", "yukl-test@example.com"], dir);
    writeFileSync(join(dir, "flow.config.json"), JSON.stringify(FLOW_CONFIG));
    writeFileSync(join(dir, ".yukl-intent.yml"), INTENT_YAML);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "base"], dir);
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

function featureConfig() {
  return {
    ...FLOW_CONFIG,
    pipeline: [
      ...FLOW_CONFIG.pipeline,
      {
        id: "extra-stage",
        title: "Extra stage",
        enabled: true,
        agent: "claude",
        writes: "extra-out.md",
        reads: [],
        spec: "extra spec",
      },
    ],
  };
}

function writeContract(dir, command) {
  mkdirSync(join(dir, ".orchestration", "contracts"), { recursive: true });
  writeFileSync(
    join(dir, ".orchestration", "contracts", "demo.json"),
    JSON.stringify({
      task_id: "demo",
      empirical_proof: [{ command, expected_exit_code: 0 }],
      files_touched: ["flow.config.json"],
    }),
  );
}

// ---------------------------------------------------------------------------
// verify runs inside a foreign repository (acceptance: exit 0 / exit 1)
// ---------------------------------------------------------------------------

test("verify --base exits 0 in a foreign repo with an allowlisted contract", async () => {
  await withTempRepo(async (dir) => {
    git(["checkout", "-q", "-b", "feature"], dir);
    writeFileSync(join(dir, "flow.config.json"), JSON.stringify(featureConfig()));
    writeContract(dir, 'node -e "process.exit(0)"');
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "add contract"], dir);

    const result = spawnSync(process.execPath, [YUKL, "verify", "--base", "main"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(
      result.status,
      0,
      `expected exit 0; stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    );
    assert.ok(result.stdout.includes("PASS"), "checks should pass");
  });
});

test("verify --base exits 1 in a foreign repo when the contract command is not allowlisted", async () => {
  await withTempRepo(async (dir) => {
    git(["checkout", "-q", "-b", "feature"], dir);
    writeFileSync(join(dir, "flow.config.json"), JSON.stringify(featureConfig()));
    writeContract(dir, "node -e \"require('node:fs').writeFileSync('marker.txt', 'x')\"");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "add contract"], dir);

    const result = spawnSync(process.execPath, [YUKL, "verify", "--base", "main"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(result.status, 1, `expected exit 1; stdout:\n${result.stdout}`);
    assert.match(result.stdout, /FAIL allowlist/);
    assert.equal(
      existsSync(join(dir, "marker.txt")),
      false,
      "a non-allowlisted command must never be executed",
    );
  });
});

// ---------------------------------------------------------------------------
// the target repo is resolved from cwd / --cwd, never from the package dir
// ---------------------------------------------------------------------------

test("verify from an unrelated directory does not read this package's contracts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yukl-cwd-"));
  try {
    const result = spawnSync(process.execPath, [YUKL, "verify"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /contract discovery/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify --cwd points the gate at the target repository", async () => {
  await withTempRepo(async (dir) => {
    git(["checkout", "-q", "-b", "feature"], dir);
    writeFileSync(join(dir, "flow.config.json"), JSON.stringify(featureConfig()));
    writeContract(dir, 'node -e "process.exit(0)"');
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "add contract"], dir);

    const elsewhere = mkdtempSync(join(tmpdir(), "yukl-elsewhere-"));
    try {
      const result = spawnSync(process.execPath, [YUKL, "verify", "--base", "main", "--cwd", dir], {
        cwd: elsewhere,
        encoding: "utf8",
        timeout: 120000,
      });
      assert.equal(
        result.status,
        0,
        `expected exit 0; stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
      );
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

test("render resolves reads ids against the flow.config.json next to the given config", async () => {
  await withTempRepo(async (dir) => {
    const reviewConfig = {
      pipeline: [
        {
          id: "review-stage",
          writes: "review-out.md",
          reads: ["base-stage"],
          spec: "reads {reads}",
        },
      ],
    };
    writeFileSync(join(dir, "review.config.json"), JSON.stringify(reviewConfig));

    const result = spawnSync(
      process.execPath,
      [YUKL, "render", "review-stage", "--config", "review.config.json"],
      { cwd: dir, encoding: "utf8", timeout: 60000 },
    );
    assert.equal(result.status, 0, `expected exit 0; stderr:\n${result.stderr}`);
    assert.ok(
      result.stdout.includes("base-out.md"),
      `the fallback pipeline should come from the target repo; got:\n${result.stdout}`,
    );
  });
});
