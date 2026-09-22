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
export const INTENTS_DIR = ".orchestration/intents";
const YUKL_CONFIG_PATH = "yukl.config.json";
const LEGACY_INTENT_PATH = ".yukl-intent.yml";
const CONTRACT_FILE_RE = /^\.orchestration\/contracts\/[^/]+\.json$/;

/** True when a repo-relative path is a contract file. */
export function isContractFile(path) {
  return CONTRACT_FILE_RE.test(path);
}

function isAllowedDocPath(path) {
  return (
    path.startsWith("docs/") ||
    path.startsWith(`${INTENTS_DIR}/`) ||
    /^[^/]+\.md$/.test(path) ||
    path.startsWith(`${CONTRACTS_DIR}/`)
  );
}

// ---------------------------------------------------------------------------
// path patterns (in-house glob matcher)
// ---------------------------------------------------------------------------

/**
 * Compile a repo-relative path pattern into a RegExp. Supports three forms
 * only, kept deliberately small so the gate has no glob dependency:
 *   - literal segments ("CHANGELOG.md", "docs/YUKL_ARCHITECTURE.md")
 *   - "*" matching within one segment ("tests/*.js" matches "tests/a.js" but
 *     not "tests/x/y.js")
 *   - "**" matching across any number of segments ("tests/**" matches
 *     "tests/x/y.js")
 * Patterns are anchored: they must match the whole path.
 */
export function globToRegExp(pattern) {
  const segments = String(pattern).split("/");
  let re = "^";
  let skipJoin = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!skipJoin && i > 0) re += "/";
    skipJoin = false;
    if (seg === "**") {
      while (i + 1 < segments.length && segments[i + 1] === "**") i++;
      if (i === segments.length - 1) {
        re += "(?:.*)?";
      } else {
        re += "(?:[^/]+/)*";
        skipJoin = true;
      }
    } else if (seg === "*") {
      re += "[^/]*";
    } else {
      for (const ch of seg) {
        re += ch === "*" ? "[^/]*" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
    }
  }
  return new RegExp(`${re}$`);
}

/** True when a repo-relative path matches a pattern (see globToRegExp). */
export function matchesGlob(path, pattern) {
  return globToRegExp(pattern).test(String(path).replace(/\\/g, "/"));
}

// ---------------------------------------------------------------------------
// gate configuration schemas
// ---------------------------------------------------------------------------

/**
 * Schema checks for yukl.config.json (repo-wide settings).
 * Returns an array of violation strings (empty array = valid).
 */
export function yuklConfigViolations(data) {
  const violations = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    violations.push("root must be a JSON object");
    return violations;
  }
  if (data.version !== 1) violations.push("version must be 1");
  for (const [key, label] of [
    ["commands", "commands"],
    ["folders", "folders"],
  ]) {
    const block = data[key];
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      violations.push(`${label} must be a mapping of non-empty strings`);
    } else {
      for (const [k, v] of Object.entries(block)) {
        if (typeof v !== "string" || v.trim() === "")
          violations.push(`${label}.${k} must be a non-empty string`);
      }
    }
  }
  if (!Array.isArray(data.allowlist) || data.allowlist.length === 0) {
    violations.push("allowlist must be a non-empty array");
  } else if (!data.allowlist.every((c) => typeof c === "string" && c.trim() !== "")) {
    violations.push("every allowlist entry must be a non-empty string");
  }
  return violations;
}

/**
 * Schema checks for a per-task intent file (.orchestration/intents/<task_id>.yml).
 * Returns an array of violation strings (empty array = valid).
 */
export function taskIntentViolations(doc) {
  const violations = [];
  if (!doc || typeof doc !== "object") {
    violations.push("root must be a mapping");
    return violations;
  }
  if (!doc.intent || typeof doc.intent !== "object") {
    violations.push("intent block is required");
  } else {
    if (typeof doc.intent.goal !== "string" || doc.intent.goal.trim() === "")
      violations.push("intent.goal must be a non-empty string");
    const scope = doc.intent.scope;
    if (!scope || !Array.isArray(scope.allowed_paths) || scope.allowed_paths.length === 0) {
      violations.push("intent.scope.allowed_paths must be a non-empty array");
    } else if (!scope.allowed_paths.every((p) => typeof p === "string" && p.trim() !== "")) {
      violations.push("every allowed_paths entry must be a non-empty string");
    }
    if (scope?.forbidden_paths !== undefined) {
      if (!Array.isArray(scope.forbidden_paths)) {
        violations.push("intent.scope.forbidden_paths must be an array when present");
      } else if (!scope.forbidden_paths.every((p) => typeof p === "string" && p.trim() !== "")) {
        violations.push("every forbidden_paths entry must be a non-empty string");
      }
    }
  }
  if (!doc.consultation || typeof doc.consultation.requires_human_approval !== "boolean") {
    violations.push("consultation.requires_human_approval must be a boolean");
  }
  return violations;
}

/**
 * Path enforcement as a pure function: every `file` must match one
 * `intent.intent.scope.allowed_paths` pattern and none of the
 * `forbidden_paths` patterns (forbidden wins). Contract files are exempt:
 * their path is derived from the verified task_id, not from the intent.
 * Returns an array of violation strings (empty array = all files allowed).
 */
export function checkIntentPaths(files, intentDoc) {
  const scope = intentDoc?.intent?.scope ?? {};
  const allowed = Array.isArray(scope.allowed_paths) ? scope.allowed_paths : [];
  const forbidden = Array.isArray(scope.forbidden_paths) ? scope.forbidden_paths : [];
  const violations = [];
  for (const file of files) {
    if (isContractFile(file)) continue;
    const forbiddenBy = forbidden.filter((p) => matchesGlob(file, p));
    if (forbiddenBy.length > 0) {
      violations.push(`${file} matches forbidden_paths (${forbiddenBy.join(", ")})`);
    } else if (!allowed.some((p) => matchesGlob(file, p))) {
      violations.push(`${file} matches no allowed_paths`);
    }
  }
  return violations;
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
 * (docs/**, root *.md, .orchestration/intents/**, the contracts dir) need no
 * contract coverage, but any other changed file is a code change without a
 * contract. Pure function.
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

function gitShowFile(ref, relPath, cwd) {
  const result = git(["show", `${ref}:${relPath}`], cwd);
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || "").trim() };
  }
  return { ok: true, text: result.stdout };
}

function parseYuklConfig(text, sourceLabel) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: `cannot parse ${sourceLabel} as JSON` };
  }
  const violations = yuklConfigViolations(data);
  if (violations.length > 0) {
    return { ok: false, error: `${sourceLabel} schema: ${violations.join("; ")}` };
  }
  return { ok: true, allowlist: data.allowlist };
}

/**
 * Resolve the proof-command allowlist and the gate mode for a verify run.
 * With `--base` both yukl.config.json and (in legacy mode) .yukl-intent.yml
 * are read from the base ref via `git show`, never from the working tree or
 * HEAD: a PR cannot widen its own allowlist. Without `--base` the same files
 * are read from the working tree, which makes local mode a developer preview
 * rather than a trust boundary. When yukl.config.json is absent the legacy
 * .yukl-intent.yml allowlist is used, so pre-split repositories keep working.
 * Returns { ok: true, mode: "config"|"legacy", allowlist } or { ok: false, error }.
 */
export function resolveGateConfig({ base = null, cwd = process.cwd() } = {}) {
  if (base != null) {
    const config = gitShowFile(base, YUKL_CONFIG_PATH, cwd);
    if (config.ok) {
      return {
        ...parseYuklConfig(config.text, `${YUKL_CONFIG_PATH} at ${base}`),
        mode: "config",
      };
    }
    const legacy = gitShowFile(base, LEGACY_INTENT_PATH, cwd);
    if (legacy.ok) {
      const parsed = intentAllowlist(legacy.text);
      return parsed.ok
        ? { ok: true, allowlist: parsed.commands, mode: "legacy" }
        : { ok: false, error: parsed.error, mode: "legacy" };
    }
    return {
      ok: false,
      error: `cannot read ${YUKL_CONFIG_PATH} or ${LEGACY_INTENT_PATH} at ${base}: ${
        config.error || legacy.error
      }`,
    };
  }

  const configPath = join(cwd, YUKL_CONFIG_PATH);
  if (existsSync(configPath)) {
    return {
      ...parseYuklConfig(readFileSync(configPath, "utf8"), `${YUKL_CONFIG_PATH} (working tree)`),
      mode: "config",
    };
  }
  const legacyPath = join(cwd, LEGACY_INTENT_PATH);
  if (existsSync(legacyPath)) {
    const parsed = intentAllowlist(readFileSync(legacyPath, "utf8"));
    return parsed.ok
      ? { ok: true, allowlist: parsed.commands, mode: "legacy" }
      : { ok: false, error: parsed.error, mode: "legacy" };
  }
  return {
    ok: false,
    error: `neither ${YUKL_CONFIG_PATH} nor ${LEGACY_INTENT_PATH} found in the working tree`,
  };
}

/**
 * Read one contract's per-task intent and check its paths.
 * With `--base` the intent is read from the base ref via `git show`; without
 * it, from the working tree.
 * Returns { ok: true, doc } or { ok: false, missing, error } where `missing`
 * distinguishes an absent intent file from a present-but-invalid one, so the
 * caller can downgrade a missing intent to a warning in local mode only.
 */
export function resolveIntentForContract({ taskId, base = null, cwd = process.cwd() } = {}) {
  const intentRelPath = `${INTENTS_DIR}/${taskId}.yml`;
  if (base != null) {
    const shown = gitShowFile(base, intentRelPath, cwd);
    if (!shown.ok) {
      return {
        ok: false,
        missing: true,
        error: `intent for ${taskId} not found at ${base}; merge the intent first`,
      };
    }
    return parseTaskIntent(shown.text, `${intentRelPath} at ${base}`);
  }
  const intentAbs = resolve(cwd, intentRelPath);
  if (!existsSync(intentAbs)) {
    return {
      ok: false,
      missing: true,
      error: `no intent for ${taskId} (pre-intent contract); paths not enforced`,
    };
  }
  return parseTaskIntent(readFileSync(intentAbs, "utf8"), intentRelPath);
}

function parseTaskIntent(text, sourceLabel) {
  let doc;
  try {
    doc = yaml.load(text);
  } catch (err) {
    return {
      ok: false,
      missing: false,
      error: `cannot parse ${sourceLabel} as YAML: ${err.message}`,
    };
  }
  const violations = taskIntentViolations(doc);
  if (violations.length > 0) {
    return {
      ok: false,
      missing: false,
      error: `${sourceLabel} schema: ${violations.join("; ")}`,
    };
  }
  return { ok: true, doc };
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

/** True when a repo-relative file already exists at the given ref. */
export function fileExistsAtBase(base, relPath, cwd) {
  const result = git(["cat-file", "-e", `${base}:${relPath.replace(/\\/g, "/")}`], cwd);
  return result.status === 0;
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
 * `allowlist`, `gateMode`, `diffFiles` and `porcelain` are injectable for
 * tests. When `allowlist` is null, the gate config is resolved from
 * yukl.config.json (or the legacy .yukl-intent.yml fallback) - from `--base`
 * via git show, or from the working tree without `--base`; in "config" mode
 * every verified contract must additionally have a per-task intent at
 * .orchestration/intents/<task_id>.yml (read from the same source), and each
 * file it covers must satisfy that intent's allowed/forbidden paths. In
 * "config" mode with `--base`, a contract that already exists at the base ref
 * is refused (one intent authorises one PR), so a PR cannot rewrite a merged
 * contract to inherit its merged intent. The diff
 * is computed from `git diff base...HEAD` and the working tree is inspected
 * via `git status --porcelain`. `timeoutMs` bounds each proof command
 * (default 600000 ms).
 * Returns { ok, checks: [{ name, status: "PASS"|"WARN"|"FAIL", detail }] }.
 */
export async function runVerify({
  contractPaths = [],
  base = null,
  allowlist = null,
  gateMode = null,
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
        "scope: every changed file is doc-exempt (docs/**, root *.md, .orchestration/intents/**, contracts)",
        violations.length === 0,
        violations.length > 0 ? violations.join(", ") : "",
      );
      return { ok: checks.every((c) => c.status !== "FAIL"), checks };
    }
    record("contracts", false, "no contract files found to verify");
    return { ok: false, checks };
  }

  if (allowlist == null) {
    const resolution = resolveGateConfig({ base, cwd });
    if (!resolution.ok) {
      record("allowlist", false, resolution.error);
      return { ok: false, checks };
    }
    allowlist = resolution.allowlist;
    gateMode = resolution.mode;
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

    if (base != null && gateMode === "config" && fileExistsAtBase(base, contractPath, cwd)) {
      const taskId = data?.task_id ?? stem.replace(/\.json$/i, "");
      record(
        `contract ${stem} replay`,
        false,
        `contract ${taskId} is already merged at ${base}; an intent authorises one PR, so use a new task_id`,
      );
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

    if (gateMode === "config") {
      const resolution = resolveIntentForContract({
        taskId: data.task_id,
        base,
        cwd,
      });
      if (!resolution.ok) {
        if (resolution.missing && base == null) {
          // Local mode only: a contract that predates the intent split is
          // downgraded to a warning, so `npm run verify` stays usable in
          // repositories carrying pre-intent contracts. The --base gate is
          // strict: a missing intent there still fails.
          checks.push({
            name: `contract ${stem} intent`,
            status: "WARN",
            detail: resolution.error,
          });
        } else {
          record(`contract ${stem} intent`, false, resolution.error);
        }
      } else {
        const pathViolations = checkIntentPaths(data.files_touched, resolution.doc);
        record(
          `contract ${stem} paths`,
          pathViolations.length === 0,
          pathViolations.length > 0 ? pathViolations.join(", ") : "",
        );
      }
    }

    for (const [i, claim] of data.empirical_proof.entries()) {
      const label = `${stem} proof ${i + 1} "${claim.command}"`;
      if (!allowed.has(claim.command)) {
        record(
          `allowlist ${label}`,
          false,
          "command is not in the proof-command allowlist (yukl.config.json, or the legacy .yukl-intent.yml); not executed",
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
        ? "diff changes files outside docs/**, root *.md, .orchestration/intents/** and .orchestration/contracts/** but adds or modifies no contract file"
        : "",
    );
    const diffSet = new Set(diffFiles);
    const notInDiff = contracts.flatMap((c) =>
      c.files_touched.filter((f) => !diffSet.has(f)).map((f) => `${c.task_id} lists ${f}`),
    );
    record(
      "scope: files_touched only lists files changed in the diff",
      notInDiff.length === 0,
      notInDiff.length > 0 ? notInDiff.join(", ") : "",
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
