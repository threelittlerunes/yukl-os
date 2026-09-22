#!/usr/bin/env node
// yukl - agent-agnostic runtime for the Yukl Power Harness.
//
//   yukl render <stage-id> [--config <path>] [--task-id <id>] [--cwd <dir>]
//   yukl verify [<contract-path>...] [--base <git-ref>] [--timeout-ms <ms>] [--cwd <dir>]
//
// The binding layer is deterministic checks, not prompts. `render` expands a
// pipeline stage spec for any agent runtime (Claude Code, OpenCode, Antigravity,
// Orca or none); `verify` enforces the Rational Persuasion contract and is
// designed to be the merge gate a CI job runs on pull requests.
//
// The target repository is always resolved from the caller's working directory
// (`process.cwd()`) or an explicit --cwd flag, never from the directory this
// package is installed in.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import yaml from "js-yaml";

export const CONTRACTS_DIR = ".orchestration/contracts";
const CONTRACT_FILE_RE = /^\.orchestration\/contracts\/[^/]+\.json$/;

/** True when a repo-relative path is a contract file. */
export function isContractFile(path) {
  return CONTRACT_FILE_RE.test(path);
}

function isAllowedDocPath(path) {
  return (
    path.startsWith("docs/") || /^[^/]+\.md$/.test(path) || path.startsWith(`${CONTRACTS_DIR}/`)
  );
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function substituteTaskId(text, taskId) {
  return taskId == null ? text : text.split("<task_id>").join(taskId);
}

function needsTaskId(text) {
  return typeof text === "string" && text.includes("<task_id>");
}

/**
 * Expand a pipeline stage spec into concrete paths.
 * Returns { ok: true, spec } or { ok: false, error }.
 */
export function renderStage(configPath, stageId, taskId = null) {
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return { ok: false, error: `cannot read config ${configPath}` };
  }
  const pipeline = Array.isArray(config?.pipeline) ? config.pipeline : [];
  const stage = pipeline.find((s) => s?.id === stageId);
  if (!stage) return { ok: false, error: `unknown stage id "${stageId}" in ${configPath}` };

  const byId = new Map(pipeline.map((s) => [s.id, s]));

  // A reads id may reference a stage defined in the default pipeline
  // (flow.config.json) when the given config is a different file, e.g.
  // review.config.json reading the expert-power-drafter stage. The fallback
  // lives next to the given config (i.e. in the target repository), not in
  // the directory this package happens to be installed in.
  const fallbackConfigPath = join(dirname(resolve(configPath)), "flow.config.json");
  const searchedFallback =
    resolve(configPath) !== resolve(fallbackConfigPath) && existsSync(fallbackConfigPath);
  let fallbackPipeline = [];
  if (searchedFallback) {
    try {
      const flowConfig = JSON.parse(readFileSync(fallbackConfigPath, "utf8"));
      fallbackPipeline = Array.isArray(flowConfig?.pipeline) ? flowConfig.pipeline : [];
    } catch {
      fallbackPipeline = [];
    }
  }

  const writes = typeof stage.writes === "string" ? stage.writes : "";
  const readWrites = [];
  for (const readId of stage.reads ?? []) {
    const readStage = byId.get(readId) ?? fallbackPipeline.find((s) => s?.id === readId);
    if (!readStage) {
      const searched = searchedFallback ? `${configPath} or ${fallbackConfigPath}` : configPath;
      return {
        ok: false,
        error: `stage "${readId}" listed in "reads" of "${stageId}" does not exist in ${searched}`,
      };
    }
    readWrites.push(typeof readStage.writes === "string" ? readStage.writes : "");
  }

  if (
    taskId == null &&
    (needsTaskId(writes) || readWrites.some(needsTaskId) || needsTaskId(stage.spec))
  ) {
    return { ok: false, error: `stage "${stageId}" needs a <task_id> but --task-id is missing` };
  }

  const out = substituteTaskId(writes, taskId);
  const reads = readWrites.map((w) => substituteTaskId(w, taskId)).join(", ");

  let spec = typeof stage.spec === "string" ? stage.spec : "";
  spec = substituteTaskId(spec, taskId);
  spec = spec.split("{reads}").join(reads);
  spec = spec.split("{out}").join(out);

  const unresolved = spec.match(/\{[A-Za-z0-9_-]+\}|<task_id>/g);
  if (unresolved) {
    return {
      ok: false,
      error: `unresolved placeholder(s) after substitution: ${unresolved.join(", ")}`,
    };
  }

  return { ok: true, spec };
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

/**
 * Schema checks for a single contract file.
 * Returns an array of violation strings (empty array = valid).
 */
export function contractViolations(contractPath, data) {
  const violations = [];
  const stem = basename(contractPath).replace(/\.json$/i, "");

  if (typeof data?.task_id !== "string" || data.task_id.trim() === "") {
    violations.push("task_id must be a non-empty string");
  } else if (data.task_id !== stem) {
    violations.push(`task_id "${data.task_id}" does not match the filename stem "${stem}"`);
  }

  if (!Array.isArray(data?.empirical_proof) || data.empirical_proof.length === 0) {
    violations.push("empirical_proof must be a non-empty array");
  } else {
    data.empirical_proof.forEach((claim, i) => {
      if (typeof claim?.command !== "string" || claim.command.trim() === "") {
        violations.push(`empirical_proof[${i}].command must be a non-empty string`);
      }
      if (typeof claim?.expected_exit_code !== "number") {
        violations.push(`empirical_proof[${i}].expected_exit_code must be a number`);
      } else if (claim.expected_exit_code !== 0) {
        violations.push(`empirical_proof[${i}].expected_exit_code must be 0`);
      }
    });
  }

  if (!Array.isArray(data?.files_touched) || data.files_touched.length === 0) {
    violations.push("files_touched must be a non-empty array");
  } else if (!data.files_touched.every((p) => typeof p === "string" && p.trim() !== "")) {
    violations.push("every files_touched entry must be a non-empty string");
  }

  return violations;
}

/**
 * Scope rules as a pure function.
 * `diffFiles` are repo-relative paths changed between --base and HEAD;
 * `contracts` are the verified contracts ({ task_id, files_touched, path }).
 * Returns { uncovered, codeWithoutContract }.
 */
export function checkScope(diffFiles, contracts) {
  const covered = new Set(
    contracts.flatMap((c) => (Array.isArray(c.files_touched) ? c.files_touched : [])),
  );
  const uncovered = diffFiles.filter((f) => !isContractFile(f) && !covered.has(f));
  const hasContractInDiff = diffFiles.some(isContractFile);
  const codeWithoutContract = diffFiles.some((f) => !isAllowedDocPath(f)) && !hasContractInDiff;
  return { uncovered, codeWithoutContract };
}

/**
 * Scope rules for a diff that carries no contract files: doc-exempt paths
 * (docs/**, root *.md, the contracts dir) need no contract coverage, but any
 * other changed file is a code change without a contract. Pure function.
 */
export function checkScopeWithoutContracts(diffFiles) {
  return { violations: diffFiles.filter((f) => !isAllowedDocPath(f)) };
}

/**
 * Inspect `git status --porcelain` output and return a warning when the
 * working tree carries uncommitted or untracked changes outside
 * node_modules/. `jujutsu` marks a colocated Jujutsu workspace (`.jj`
 * present): there, work in the working-copy commit is invisible to
 * `git diff base...HEAD` until HEAD advances, so the warning names `jj new`.
 * Returns null when the tree is clean. Pure function.
 */
export function dirtyTreeWarning(porcelain, jujutsu = false) {
  const dirty = porcelain
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => !line.slice(3).startsWith("node_modules/"));
  if (!dirty) return null;
  const base =
    "WARNING: working tree has uncommitted or untracked changes; " +
    "verify --base checks committed state only (base...HEAD). " +
    "Commit first for an accurate preview.";
  if (!jujutsu) return base;
  return (
    `${base} Colocated Jujutsu: work in the working-copy commit is not on HEAD, ` +
    "so it is invisible to git diff; run `jj new` so the change becomes HEAD."
  );
}

/**
 * Extract the command allowlist from .yukl-intent.yml text.
 * Returns { ok: true, commands } or { ok: false, error }.
 */
export function intentAllowlist(intentText) {
  let doc;
  try {
    doc = yaml.load(intentText);
  } catch {
    return { ok: false, error: "cannot parse .yukl-intent.yml as YAML" };
  }
  const proofs = doc?.rational_persuasion?.empirical_proof;
  if (!Array.isArray(proofs) || proofs.length === 0) {
    return { ok: false, error: "rational_persuasion.empirical_proof is missing or empty" };
  }
  const commands = [];
  for (const claim of proofs) {
    if (typeof claim?.command !== "string" || claim.command.trim() === "") {
      return {
        ok: false,
        error: "rational_persuasion.empirical_proof contains a claim without a command",
      };
    }
    commands.push(claim.command);
  }
  return { ok: true, commands };
}

function runCommand(command, cwd, timeoutMs = 600000) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
    });
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      finish({ code: null, timedOut: true, stderr });
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      finish({ code: null, stderr: `${stderr}${err.message}` });
    });
    child.on("close", (code) => {
      finish({ code, stderr });
    });
  });
}

function tailLines(text, count) {
  return text.split(/\r?\n/).filter(Boolean).slice(-count).join("\n");
}

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function gitDiffFiles(base, cwd) {
  const result = git(["diff", "--name-only", `${base}...HEAD`], cwd);
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || "").trim() };
  }
  return { ok: true, files: result.stdout.split(/\r?\n/).filter(Boolean) };
}

/**
 * Refuse a Jujutsu-only repository. A repo root with `.jj` but no `.git`
 * (file or directory) has no Git metadata, so `git diff` and `git show`
 * cannot run. Colocated mode (`jj git colocation enable`) keeps a `.git` next
 * to `.jj` and is fine; a secondary `jj workspace add` has no `.git` and is
 * refused. Returns null when the layout is acceptable. Pure function.
 */
export function vcsViolation(cwd) {
  const hasJujutsu = existsSync(join(cwd, ".jj"));
  const hasGit = existsSync(join(cwd, ".git"));
  if (hasJujutsu && !hasGit) {
    return (
      "Jujutsu-only repository: .jj exists but .git does not (as file or directory). " +
      "yukl verify requires Git metadata; run jj git colocation enable to convert the " +
      "workspace into a colocated Jujutsu/Git workspace."
    );
  }
  return null;
}

/**
 * Run the Rational Persuasion gate.
 * `allowlist`, `diffFiles` and `porcelain` are injectable for tests; when null
 * the allowlist is read from .yukl-intent.yml (from the working tree, or from
 * --base via git show), the diff is computed from `git diff --base...HEAD` and
 * the working tree is inspected via `git status --porcelain`. `timeoutMs`
 * bounds each proof command (default 600000 ms).
 * Returns { ok, checks: [{ name, status: "PASS"|"WARN"|"FAIL", detail }] }.
 */
export async function runVerify({
  contractPaths = [],
  base = null,
  allowlist = null,
  diffFiles = null,
  porcelain = null,
  timeoutMs = 600000,
  cwd = process.cwd(),
} = {}) {
  const checks = [];
  const record = (name, ok, detail = "") =>
    checks.push({ name, status: ok ? "PASS" : "FAIL", detail });

  const vcsError = vcsViolation(cwd);
  if (vcsError) {
    record("repo has Git metadata (colocated Jujutsu supported)", false, vcsError);
    return { ok: false, checks };
  }
  record("repo has Git metadata (colocated Jujutsu supported)", true);

  if (base != null) {
    if (porcelain == null) {
      const status = git(["status", "--porcelain"], cwd);
      porcelain = status.status === 0 ? status.stdout : "";
    }
    const warning = dirtyTreeWarning(porcelain, existsSync(join(cwd, ".jj")));
    if (warning) {
      console.error(warning);
      checks.push({ name: "working tree clean", status: "WARN", detail: warning });
    } else {
      record("working tree clean", true);
    }
  }

  if (contractPaths.length === 0) {
    if (base != null) {
      if (diffFiles == null) {
        const diff = gitDiffFiles(base, cwd);
        if (!diff.ok) {
          record("contract discovery", false, `git diff ${base}...HEAD failed: ${diff.error}`);
          return { ok: false, checks };
        }
        diffFiles = diff.files;
      }
      contractPaths = diffFiles.filter(isContractFile).filter((p) => existsSync(resolve(cwd, p)));
    } else {
      try {
        contractPaths = readdirSync(join(cwd, CONTRACTS_DIR))
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) => `${CONTRACTS_DIR}/${f}`);
      } catch (err) {
        record("contract discovery", false, `cannot list ${CONTRACTS_DIR}: ${err.message}`);
        return { ok: false, checks };
      }
    }
  }

  if (contractPaths.length === 0) {
    if (base != null) {
      // Docs-only PRs carry no contract files: only the scope check applies.
      const { violations } = checkScopeWithoutContracts(diffFiles);
      record(
        "scope: every changed file is doc-exempt (docs/**, root *.md, contracts)",
        violations.length === 0,
        violations.length > 0 ? violations.join(", ") : "",
      );
      return { ok: checks.every((c) => c.status !== "FAIL"), checks };
    }
    record("contracts", false, "no contract files found to verify");
    return { ok: false, checks };
  }

  if (allowlist == null) {
    let intentText;
    if (base != null) {
      const result = git(["show", `${base}:.yukl-intent.yml`], cwd);
      if (result.status !== 0) {
        record(
          "allowlist",
          false,
          `cannot read .yukl-intent.yml at ${base}: ${(result.stderr || "").trim()}`,
        );
        return { ok: false, checks };
      }
      intentText = result.stdout;
    } else {
      intentText = readFileSync(join(cwd, ".yukl-intent.yml"), "utf8");
    }
    const parsed = intentAllowlist(intentText);
    if (!parsed.ok) {
      record("allowlist", false, parsed.error);
      return { ok: false, checks };
    }
    allowlist = parsed.commands;
  }
  const allowed = new Set(allowlist);

  const contracts = [];

  for (const contractPath of contractPaths) {
    const absPath = resolve(cwd, contractPath);
    const stem = basename(contractPath);

    if (!existsSync(absPath)) {
      record(`contract ${stem}`, false, "file not found");
      continue;
    }

    let data;
    try {
      data = JSON.parse(readFileSync(absPath, "utf8"));
    } catch (err) {
      record(`contract ${stem} schema`, false, `cannot parse JSON: ${err.message}`);
      continue;
    }

    const violations = contractViolations(contractPath, data);
    if (violations.length > 0) {
      record(`contract ${stem} schema`, false, violations.join("; "));
      continue;
    }
    record(`contract ${stem} schema`, true);
    contracts.push({
      path: contractPath,
      task_id: data.task_id,
      files_touched: data.files_touched,
    });

    for (const [i, claim] of data.empirical_proof.entries()) {
      const label = `${stem} proof ${i + 1} "${claim.command}"`;
      if (!allowed.has(claim.command)) {
        record(
          `allowlist ${label}`,
          false,
          "command is not in the .yukl-intent.yml empirical_proof allowlist; not executed",
        );
        continue;
      }
      record(`allowlist ${label}`, true);

      const result = await runCommand(claim.command, cwd, timeoutMs);
      if (result.timedOut) {
        record(`command ${label}`, false, `timed out after ${timeoutMs} ms`);
        continue;
      }
      const okExit = result.code === claim.expected_exit_code;
      record(
        `command ${label}`,
        okExit,
        okExit
          ? `exit ${result.code}`
          : `expected exit ${claim.expected_exit_code}, got ${result.code}; stderr (last 40 lines):\n${tailLines(result.stderr, 40)}`,
      );
    }
  }

  if (base != null) {
    if (diffFiles == null) {
      const diff = gitDiffFiles(base, cwd);
      if (!diff.ok) {
        record("scope", false, `git diff ${base}...HEAD failed: ${diff.error}`);
        return { ok: false, checks };
      }
      diffFiles = diff.files;
    }
    const scope = checkScope(diffFiles, contracts);
    record(
      "scope: every changed file is covered by a verified contract",
      scope.uncovered.length === 0,
      scope.uncovered.length > 0 ? scope.uncovered.join(", ") : "",
    );
    record(
      "scope: code change is accompanied by a contract file",
      !scope.codeWithoutContract,
      scope.codeWithoutContract
        ? "diff changes files outside docs/**, root *.md and .orchestration/contracts/** but adds or modifies no contract file"
        : "",
    );
  }

  const ok = checks.every((c) => c.status !== "FAIL");
  return { ok, checks };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  "usage:",
  "  yukl render <stage-id> [--config <path>] [--task-id <id>] [--cwd <dir>]",
  "  yukl verify [<contract-path>...] [--base <git-ref>] [--timeout-ms <ms>] [--cwd <dir>]",
].join("\n");

function parseArgs(argv) {
  const options = { positional: [] };
  const valueFlags = new Map([
    ["--config", "config"],
    ["--task-id", "taskId"],
    ["--base", "base"],
    ["--timeout-ms", "timeoutMs"],
    ["--cwd", "cwd"],
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (valueFlags.has(arg)) {
      const key = valueFlags.get(arg);
      const value = argv[++i];
      if (value === undefined) return { error: `${arg} requires a value` };
      options[key] = value;
    } else if (arg.startsWith("--")) {
      return { error: `unknown option ${arg}` };
    } else {
      options.positional.push(arg);
    }
  }
  return { options };
}

async function main() {
  const { options, error } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(`yukl: ${error}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const [command, ...positional] = options.positional;
  const cwd = resolve(options.cwd ?? process.cwd());

  if (command === "render") {
    const [stageId, ...rest] = positional;
    if (!stageId || rest.length > 0) {
      console.error(`yukl: render requires exactly one stage id\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    const configPath = resolve(cwd, options.config ?? "flow.config.json");
    const result = renderStage(configPath, stageId, options.taskId ?? null);
    if (!result.ok) {
      console.error(`yukl render: ${result.error}`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${result.spec}\n`);
    return;
  }

  if (command === "verify") {
    let timeoutMs = 600000;
    if (options.timeoutMs != null) {
      timeoutMs = Number(options.timeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        console.error(`yukl: --timeout-ms requires a positive integer (milliseconds)\n\n${USAGE}`);
        process.exitCode = 2;
        return;
      }
    }
    const result = await runVerify({
      contractPaths: positional,
      base: options.base ?? null,
      timeoutMs,
      cwd,
    });
    for (const check of result.checks) {
      const line = `${check.status} ${check.name}`;
      console.log(check.detail ? `${line}: ${check.detail}` : line);
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  console.error(`yukl: unknown command "${command}"\n\n${USAGE}`);
  process.exitCode = 2;
}

if (process.argv[1]?.endsWith("yukl.js")) {
  main();
}
