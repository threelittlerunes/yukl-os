#!/usr/bin/env node
// yukl - agent-agnostic runtime for the Yukl Power Harness.
//
//   yukl render <stage-id> [--config <path>] [--task-id <id>] [--cwd <dir>]
//   yukl verify [<contract-path>...] [--base <git-ref>] [--timeout-ms <ms>] [--cwd <dir>]
//   yukl init [--cwd <dir>] [--force] [--yukl-pin <commit-sha>]
//
// The binding layer is deterministic checks, not prompts. `render` expands a
// pipeline stage spec for any agent runtime (Claude Code, OpenCode, Antigravity,
// Orca or none); `verify` enforces the Rational Persuasion contract and is
// designed to be the merge gate a CI job runs on pull requests; `init`
// installs the harness into a target repository on a feature branch without
// overwriting anything the repository already has.
//
// The target repository is always resolved from the caller's working directory
// (`process.cwd()`) or an explicit --cwd flag, never from the directory this
// package is installed in.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";

export const CONTRACTS_DIR = ".orchestration/contracts";
export const INTENTS_DIR = ".orchestration/intents";
const YUKL_CONFIG_PATH = "yukl.config.json";
const LEGACY_INTENT_PATH = ".yukl-intent.yml";
const CONTRACT_FILE_RE = /^\.orchestration\/contracts\/[^/]+\.json$/;
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES_DIR = join(PACKAGE_ROOT, "templates");

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
 *
 * `commands` entries may be `null`: `yukl init` records a command it could
 * not detect as null instead of guessing one, and a null entry is skipped
 * rather than treated as a malformed value. `allowlist` never contains
 * nulls (undetected commands cannot be proven against, so they are never
 * allowlisted).
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
        if (v === null) continue;
        if (typeof v !== "string" || v.trim() === "")
          violations.push(`${label}.${k} must be a non-empty string or null`);
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
// init: install the harness into a target repository
// ---------------------------------------------------------------------------

export const YUKL_BEGIN = "<!-- yukl:begin -->";
export const YUKL_END = "<!-- yukl:end -->";
export const AGENT_DOC_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"];
const YUKL_CONFIG_SKELETON = {
  version: 1,
  commands: {
    build: null,
    test: null,
    format: null,
    lint: null,
    python_check: null,
    python_test: null,
  },
  folders: {
    contracts: ".orchestration/contracts",
    intents: ".orchestration/intents",
    locks: ".orchestration/locks",
    artifacts: ".orchestration/artifacts",
  },
  allowlist: [],
};

/**
 * Detect the target repo's Node commands from package.json scripts.
 * Returns { build, test, format, lint } each "npm run <name>" or null.
 * A missing package.json, unparsable JSON or an absent script yields null;
 * nothing is ever guessed. Pure function.
 */
export function detectNodeCommands(packageJsonText) {
  let scripts = {};
  try {
    scripts = JSON.parse(packageJsonText)?.scripts ?? {};
  } catch {
    scripts = {};
  }
  const out = {};
  for (const key of ["build", "test", "format", "lint"]) {
    out[key] =
      typeof scripts[key] === "string" && scripts[key].trim() !== "" ? `npm run ${key}` : null;
  }
  return out;
}

/**
 * Detect the target repo's Python commands from pyproject.toml. This is a
 * line-based scan, NOT a TOML parse: a `[tool.ruff]` section header records
 * `ruff check` and a `[tool.pytest...]` header records `pytest`, and that is
 * all. Limits: headers must start at column 0, sections are not merged
 * (a `[tool.ruff.lint]` table without a `[tool.ruff]` table goes unseen),
 * and any other tool (black, mypy, tox, ...) is not detected and yields null.
 * Returns { check, test } each a command string or null. Pure function.
 */
export function detectPythonCommands(pyprojectText) {
  const out = { check: null, test: null };
  for (const line of pyprojectText.split(/\r?\n/)) {
    if (/^\[tool\.ruff(\.|\])/.test(line)) out.check = "ruff check";
    else if (/^\[tool\.pytest/.test(line)) out.test = "pytest";
  }
  return out;
}

/**
 * Detect whether pyproject.toml declares a `dev` or `test` extra under
 * `[project.optional-dependencies]` (line-based scan, NOT a TOML parse:
 * the header must start at column 0 and the extra key must open its own
 * line, bare or quoted). Returns "dev", "test" or null. Pure function.
 */
export function detectPythonExtras(pyprojectText) {
  const lines = pyprojectText.split(/\r?\n/);
  let inOptional = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (line.startsWith("[")) {
      inOptional = trimmed === "[project.optional-dependencies]";
      continue;
    }
    if (inOptional) {
      const match = /^["']?(dev|test)["']?\s*=/.exec(trimmed);
      if (match) return match[1];
    }
  }
  return null;
}

/**
 * Decide which directories hold the target repo's projects. The root ("")
 * is always scanned; `--project-dir` values add directories (a single
 * relative name, no slashes); when the root has neither package.json nor
 * pyproject.toml and no --project-dir was passed, directories exactly one
 * level below the root are scanned and any holding one of those files is
 * added, with a warning naming what was found. Returns { dirs, warnings }
 * or { error }. Pure function over the given repository.
 */
export function detectProjectDirs(cwd, explicit = []) {
  const dirs = [""];
  const warnings = [];
  for (const rel of explicit) {
    if (!/^[^/\\]+$/.test(rel) || rel === "." || rel === "..") {
      return { error: `--project-dir "${rel}" must be a single relative directory name` };
    }
    if (!existsSync(join(cwd, rel))) {
      return { error: `--project-dir "${rel}" does not exist in the repository` };
    }
    if (!dirs.includes(rel)) dirs.push(rel);
  }
  const hasRootProject =
    existsSync(join(cwd, "package.json")) || existsSync(join(cwd, "pyproject.toml"));
  if (!hasRootProject && explicit.length === 0) {
    const found = [];
    const detected = [];
    for (const entry of readdirSync(cwd, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules")
        continue;
      const files = [];
      if (existsSync(join(cwd, entry.name, "pyproject.toml"))) files.push("pyproject.toml");
      if (existsSync(join(cwd, entry.name, "package.json"))) files.push("package.json");
      if (files.length > 0) {
        found.push(`${entry.name}/${files.join(",")}`);
        detected.push(entry.name);
      }
    }
    detected.sort();
    for (const name of detected) dirs.push(name);
    if (found.length > 0) {
      warnings.push(
        `auto-detected projects one level below the root: ${found.join("; ")}; ` +
          "pass --project-dir to control this",
      );
    }
  }
  return { dirs, warnings };
}

/**
 * Merge per-project detections into the final command map. Commands for a
 * subdirectory project are prefixed with `cd <dir> && ` because verify
 * executes allowlisted commands from the repo root (the generated CI is
 * Linux-only, and `cd X && CMD` is valid sh as well as cmd/PowerShell).
 * The root project wins key collisions; later detections are ignored with a
 * warning. Returns { commands, warnings }. Pure function.
 */
export function assembleCommands(projects) {
  const commands = {
    build: null,
    test: null,
    format: null,
    lint: null,
    python_check: null,
    python_test: null,
  };
  const from = {};
  const warnings = [];
  for (const project of projects) {
    const prefix = project.dir === "" ? "" : `cd ${project.dir} && `;
    const candidates = {
      build: project.node.build,
      test: project.node.test,
      format: project.node.format,
      lint: project.node.lint,
      python_check: project.python.check,
      python_test: project.python.test,
    };
    for (const [key, raw] of Object.entries(candidates)) {
      if (raw === null) continue;
      if (commands[key] === null) {
        commands[key] = `${prefix}${raw}`;
        from[key] = project.dir === "" ? "the repository root" : project.dir;
      } else {
        warnings.push(
          `commands.${key} from "${project.dir}" ignored; already detected in ${from[key]}`,
        );
      }
    }
  }
  return { commands, warnings };
}

/**
 * Render yukl.config.json for a target repo from the final command map.
 * Undetected commands stay null (criterion 3: never guessed) and only
 * detected commands are allowlisted, so the gate can only ever run checks
 * the repo demonstrably has.
 */
export function renderYuklConfig(commands) {
  return {
    version: 1,
    commands: { ...commands },
    folders: { ...YUKL_CONFIG_SKELETON.folders },
    allowlist: Object.values(commands).filter((c) => c !== null),
  };
}

/**
 * Insert or replace the marked yukl section in an agent doc. Content before
 * `<!-- yukl:begin -->` and after the end-marker line is preserved byte for
 * byte; a second run replaces only the marked block, so init is idempotent.
 * A file without markers gets the section appended (existing bytes kept).
 * Returns { text, replaced }. Pure function.
 */
export function applyYuklSection(existingText, section) {
  const block = section.endsWith("\n") ? section : `${section}\n`;
  const beginIdx = existingText.indexOf(YUKL_BEGIN);
  const endIdx = existingText.indexOf(YUKL_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    const glue = existingText === "" ? "" : existingText.endsWith("\n") ? "\n" : "\n\n";
    return { text: `${existingText}${glue}${block}`, replaced: false };
  }
  const lineEnd = existingText.indexOf("\n", endIdx);
  const cut = lineEnd === -1 ? existingText.length : lineEnd + 1;
  return {
    text: existingText.slice(0, beginIdx) + block + existingText.slice(cut),
    replaced: true,
  };
}

/**
 * Render the yukl section for an agent doc from the detected commands.
 * The rendered section is deterministic for a given detection result, which
 * is what makes a second init run a no-op. Pure function.
 */
export function renderYuklSection(commands) {
  const detected = Object.entries(commands).filter(([, command]) => command !== null);
  const bullets =
    detected.length === 0
      ? "- none detected (edit yukl.config.json once commands exist)"
      : detected.map(([key, command]) => `- \`${command}\` (${key})`);
  return [
    YUKL_BEGIN,
    "## Yukl Power Harness",
    "",
    "This repository is governed by the [Yukl Power Harness](https://github.com/threelittlerunes/yukl-os), which maps French & Raven's bases of power and Yukl's influence tactics onto deterministic pipeline constraints. Proof contracts live in `.orchestration/contracts/<task_id>.json`, per-task scope intents in `.orchestration/intents/`, and `yukl verify --base` is the CI merge gate in `.github/workflows/yukl.yml`.",
    "",
    "Detected commands:",
    "",
    ...bullets,
    "",
    "Nothing outside the markers above is managed by the harness.",
    YUKL_END,
    "",
  ].join("\n");
}

/**
 * Detect the target repo's default branch: the local side of
 * `refs/remotes/origin/HEAD` when set, else the first of main/master that
 * exists locally, else the conventional `main`. Pure function (git only).
 */
export function detectDefaultBranch(cwd) {
  const originHead = git(["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd);
  if (originHead.status === 0) {
    const ref = originHead.stdout.trim();
    const name = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
    if (name !== "" && !name.includes("/") && !name.includes("HEAD")) return name;
  }
  for (const candidate of ["main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", candidate], cwd).status === 0) return candidate;
  }
  return "main";
}

/**
 * True when the Jujutsu working-copy commit is still exactly the default
 * branch's tip - the jj analogue of "on the default branch" (jj bookmarks
 * follow the working-copy commit, so edits made while `@` sits on the tip
 * would advance the default branch itself). Prefers the jj binary; falls
 * back to git HEAD, which colocated Jujutsu exports to the working-copy
 * commit. Returns null when the state cannot be determined. Pure function
 * over the given repo.
 */
export function jjWorkingCopyOnDefaultBranch(cwd, defaultBranch) {
  const jjCommit = (revset) =>
    spawnSync("jj", ["--repository", cwd, "log", "-r", revset, "--no-graph", "-T", "commit_id"], {
      encoding: "utf8",
    });
  const at = jjCommit("@");
  const tip = jjCommit(defaultBranch);
  if (at.status === 0 && tip.status === 0) {
    return at.stdout.trim() === tip.stdout.trim();
  }
  const head = git(["rev-parse", "HEAD"], cwd);
  const branch = git(["rev-parse", defaultBranch], cwd);
  if (head.status === 0 && branch.status === 0) {
    return head.stdout.trim() === branch.stdout.trim();
  }
  return null;
}

/**
 * Resolve the pinned yukl commit the generated CI workflow must run.
 * A CI gate that runs a floating ref can be made to run anything by anyone
 * who can move the ref, so the pin is mandatory: an explicit --yukl-pin
 * wins; otherwise the harness detects its own HEAD commit when it runs
 * from a git checkout (the exact code generating the workflow is the code
 * CI runs). Returns { ok, pin } or { ok: false, error }. Pure function.
 */
export function resolveYuklPin({ cwd, yuklPin = null } = {}) {
  if (yuklPin != null) {
    const pin = yuklPin.trim();
    if (/^\S+$/.test(pin)) return { ok: true, pin };
    return { ok: false, error: `--yukl-pin "${yuklPin}" is not a single non-empty token` };
  }
  const head = git(["rev-parse", "HEAD"], PACKAGE_ROOT);
  const sha = head.status === 0 ? head.stdout.trim() : "";
  if (/^[0-9a-f]{40}$/i.test(sha)) {
    return { ok: true, pin: sha };
  }
  return {
    ok: false,
    error:
      `cannot detect the harness commit from ${PACKAGE_ROOT} (not a git checkout); ` +
      "pass --yukl-pin <commit-sha> so the generated CI pins the yukl version it runs",
  };
}

/**
 * True when the pinned yukl commit is reachable on the yukl-os remote, so
 * `npm exec --package=github:threelittlerunes/yukl-os#<sha>` in the
 * generated CI can fetch it. Checks local remote-tracking branches first
 * (offline, authoritative for anything already fetched), then falls back to
 * scanning `git ls-remote` against the harness origin (the yukl-os repo,
 * with the well-known URL when no origin is configured, e.g. an npm
 * install). Fails closed: an offline scan counts as unreachable. The
 * `root` is the harness checkout to inspect (injectable so tests can point
 * the check at a local bare remote instead of the real one);
 * YUKL_PIN_CHECK=off skips the check entirely with a warning.
 */
export function pinReachableOnOrigin(pin, root = PACKAGE_ROOT) {
  const contains = spawnSync("git", ["branch", "-r", "--contains", pin], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
  });
  if (contains.status === 0 && contains.stdout.trim() !== "") return true;
  const url = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
  });
  const originUrl =
    url.status === 0 ? url.stdout.trim() : "https://github.com/threelittlerunes/yukl-os.git";
  const ls = spawnSync("git", ["ls-remote", originUrl], { encoding: "utf8", timeout: 60000 });
  if (ls.status !== 0) return false;
  return ls.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => line.split(/\s+/)[0].startsWith(pin));
}

/**
 * Render the generated CI workflow from the templates/yukl-ci.yml template.
 * The workflow sets up Node always, sets up Python and installs the
 * project's dependencies (with dev/test extras when pyproject.toml declares
 * them, the detected tools otherwise) only when a Python command was
 * detected, runs exactly the detected checks - each in its own subshell so
 * a subdirectory `cd` cannot leak into the next line - and gates the PR on
 * `yukl verify --base origin/<base_ref>` running a PINNED yukl commit via
 * `npm exec --package=github:threelittlerunes/yukl-os#<sha>`. The verify
 * step fails closed when the pinned yukl produces no check lines: a yukl-os
 * commit from before the task h bin-shim fix exits 0 silently through the
 * npm shim, and the guard turns that into a hard failure naming the pin. On
 * the bootstrap PR (no yukl.config.json at the base ref) the verify step
 * prints the bootstrap message and exits 0: that first PR is gated by human
 * review. The workflow is Linux-only (ubuntu-latest, sh); every recorded
 * command uses only `cd` and `&&`, which are equally valid in cmd and
 * PowerShell. Pure function over the template file.
 */
export function renderCiWorkflow({
  baseRef,
  yuklPin,
  commands,
  pythonInstall = null,
  npmInstalls = [],
}) {
  const template = readFileSync(join(TEMPLATES_DIR, "yukl-ci.yml"), "utf8");
  const npmCommands = Object.entries(commands).filter(
    ([key, command]) => command !== null && !key.startsWith("python_"),
  );
  const pythonCommands = Object.entries(commands).filter(
    ([key, command]) => command !== null && key.startsWith("python_"),
  );

  const checks = [];
  // Every line runs in its own subshell so a `cd <dir> && ` prefix in one
  // command cannot change the working directory for the next line (a second
  // `cd app` from inside app/ would fail and turn every PR red).
  for (const line of npmInstalls) checks.push(`          ( ${line} )`);
  for (const [, command] of npmCommands) checks.push(`          ( ${command} )`);
  for (const [, command] of pythonCommands) checks.push(`          ( ${command} )`);
  if (checks.length === 0) {
    checks.push('          ( echo "yukl: no repository checks detected" )');
  }

  const pythonSetup =
    pythonCommands.length > 0
      ? '      - uses: actions/setup-python@v5\n        with:\n          python-version: "3.12"\n'
      : "";

  const pythonInstallStep =
    pythonInstall == null
      ? ""
      : "      - name: Install Python dependencies\n        run: |\n" +
        `          ${pythonInstall}\n`;

  return template
    .replace(/\{BASE_REF\}/g, baseRef)
    .replace(/\{YUKL_PIN\}/g, yuklPin)
    .replace("{PYTHON_SETUP}\n", pythonSetup)
    .replace("{PYTHON_INSTALL}\n", pythonInstallStep)
    .replace("{CHECKS}", checks.join("\n"));
}

/**
 * Run `yukl init` in a target repository. All refusals are decided BEFORE
 * any write, so a refused init writes nothing. Refusals: not a Git repo
 * (task e's .git-or-colocated rule), working copy on the default branch
 * (detached HEAD counts in Git; in colocated Jujutsu, where git HEAD is
 * always detached, the working-copy commit `@` being the default branch's
 * tip counts instead), a dirty working tree (plain Git), a pin that is not
 * pushed to the yukl-os remote, and no detectable proof command with no
 * `--command` override (an empty allowlist would fail the config schema).
 * Writes yukl.config.json, the marked section in existing agent docs
 * (missing docs are skipped with a warning), .github/workflows/yukl.yml,
 * and the .gitkeep files. Existing yukl.config.json and yukl.yml are left
 * alone unless --force is passed. `checkPinReachable` is injectable for
 * tests; the YUKL_PIN_CHECK=off environment variable opts out of the
 * network check with a warning.
 * Returns { ok, error?, writes, skipped, warnings }.
 */
export function runInit({
  cwd = process.cwd(),
  force = false,
  yuklPin = null,
  projectDir = [],
  commandOverrides = [],
  checkPinReachable = undefined,
} = {}) {
  const writes = [];
  const skipped = [];
  const warnings = [];

  const refuse = (error) => ({ ok: false, error, writes, skipped, warnings });

  if (!existsSync(join(cwd, ".git")) && !existsSync(join(cwd, ".jj"))) {
    return refuse(
      `${cwd} is not a Git repository; yukl init requires a repository on a feature branch with a clean working tree`,
    );
  }
  const vcsError = vcsViolation(cwd);
  if (vcsError) return refuse(vcsError);

  const jujutsu = existsSync(join(cwd, ".jj"));
  const defaultBranch = detectDefaultBranch(cwd);

  if (jujutsu) {
    const onDefault = jjWorkingCopyOnDefaultBranch(cwd, defaultBranch);
    if (onDefault === true) {
      return refuse(
        `refusing to init: the Jujutsu working-copy commit (@) is the tip of the ` +
          `default branch "${defaultBranch}"; run jj new to start a change first`,
      );
    }
    if (onDefault === null) {
      return refuse(
        `cannot determine whether the Jujutsu working-copy commit is on the default ` +
          `branch "${defaultBranch}" (jj unavailable and git HEAD unresolved); refusing to init`,
      );
    }
  } else {
    const symbolic = git(["symbolic-ref", "-q", "HEAD"], cwd);
    if (symbolic.status !== 0) {
      return refuse(
        "refusing to init on a detached HEAD; create and check out a feature branch first",
      );
    }
    if (symbolic.stdout.trim() === `refs/heads/${defaultBranch}`) {
      return refuse(
        `refusing to init on the default branch "${defaultBranch}"; ` +
          "create and check out a feature branch first",
      );
    }
    const status = git(["status", "--porcelain"], cwd);
    const dirty = (status.status === 0 ? status.stdout : "")
      .split(/\r?\n/)
      .filter(Boolean)
      .some((line) => !line.slice(3).startsWith("node_modules/"));
    if (dirty) {
      return refuse(
        "refusing to init: the working tree has uncommitted changes; commit or stash them first",
      );
    }
  }

  const projects = [];
  {
    const detection = detectProjectDirs(cwd, projectDir);
    if (detection.error) return refuse(detection.error);
    warnings.push(...detection.warnings);
    for (const dir of detection.dirs) {
      const packageJsonPath = join(cwd, dir, "package.json");
      const pyprojectPath = join(cwd, dir, "pyproject.toml");
      const hasNode = existsSync(packageJsonPath);
      const hasPython = existsSync(pyprojectPath);
      const node = hasNode ? detectNodeCommands(readFileSync(packageJsonPath, "utf8")) : null;
      const rawPython = hasPython
        ? detectPythonCommands(readFileSync(pyprojectPath, "utf8"))
        : null;
      const python = { check: null, test: null };
      if (rawPython) {
        // In a subdirectory the module form (`python -m ruff check`) is used
        // so the command works from the repo root with the CI interpreter;
        // at the root the console scripts ("ruff check") are on the CI PATH.
        python.check = rawPython.check && (dir === "" ? rawPython.check : "python -m ruff check");
        python.test = rawPython.test && (dir === "" ? rawPython.test : "python -m pytest");
      }
      const extras = hasPython ? detectPythonExtras(readFileSync(pyprojectPath, "utf8")) : null;
      projects.push({
        dir,
        node: node ?? { build: null, test: null, format: null, lint: null },
        python,
        extras,
      });
    }
  }

  const assembled = assembleCommands(projects);
  const commands = assembled.commands;
  warnings.push(...assembled.warnings);

  for (const override of commandOverrides) {
    const eq = override.indexOf("=");
    if (eq <= 0 || eq === override.length - 1) {
      return refuse(`--command "${override}" must be <key>=<command>`);
    }
    const key = override.slice(0, eq).trim();
    const value = override.slice(eq + 1).trim();
    if (!Object.hasOwn(commands, key)) {
      return refuse(
        `--command "${override}": unknown key "${key}" ` +
          "(build, test, format, lint, python_check, python_test)",
      );
    }
    commands[key] = value;
  }

  const allowlist = Object.values(commands).filter((command) => command !== null);
  if (allowlist.length === 0) {
    return refuse(
      "no proof commands detected and none supplied; pass --command <key>=<command> " +
        "(build, test, format, lint, python_check, python_test) so yukl.config.json " +
        "has a non-empty allowlist",
    );
  }

  const pin = resolveYuklPin({ cwd, yuklPin });
  if (!pin.ok) return refuse(pin.error);

  let checker = checkPinReachable;
  if (checker === undefined && process.env.YUKL_PIN_CHECK === "off") {
    checker = null;
  } else if (checker === undefined) {
    checker = pinReachableOnOrigin;
  }
  if (checker === null) {
    warnings.push(
      "pin reachability check skipped (YUKL_PIN_CHECK=off); the generated CI may fail to fetch the pin",
    );
  } else if (!checker(pin.pin)) {
    return refuse(`pin ${pin.pin} is not pushed; push it or pass --yukl-pin <pushed sha>`);
  }

  const config = renderYuklConfig(commands);
  const configViolations = yuklConfigViolations(config);
  if (configViolations.length > 0) {
    return refuse(
      `internal error: generated yukl.config.json fails its own schema (${configViolations.join("; ")}); not written`,
    );
  }

  for (const [key, command] of Object.entries(commands)) {
    if (command === null) {
      warnings.push(`${key} not detected; yukl.config.json records it as null`);
    }
  }

  const pythonProjects = projects.filter((p) => p.python.check !== null || p.python.test !== null);
  let pythonInstall = null;
  if (pythonProjects.length > 0) {
    const extrasProject = pythonProjects.find((p) => p.extras !== null);
    if (extrasProject) {
      const dir = extrasProject.dir === "" ? "." : extrasProject.dir;
      pythonInstall = `pip install -e "${dir}[${extrasProject.extras}]"`;
    } else {
      const tools = [];
      for (const project of pythonProjects) {
        if (project.python.check !== null) tools.push("ruff");
        if (project.python.test !== null) tools.push("pytest");
      }
      pythonInstall = `pip install ${[...new Set(tools)].join(" ")}`;
      warnings.push(
        `no dev/test extra under [project.optional-dependencies]; the generated CI installs ` +
          `the detected tools (${[...new Set(tools)].join(", ")}) instead of the project`,
      );
    }
  }

  const npmInstalls = projects
    .filter((p) => p.node !== null && Object.values(p.node).some((command) => command !== null))
    .map((p) =>
      p.dir === "" ? "if [ -f package.json ]; then npm ci; fi" : `cd ${p.dir} && npm ci`,
    );

  const configText = `${JSON.stringify(config, null, 2)}\n`;
  const configRel = "yukl.config.json";
  if (existsSync(join(cwd, configRel))) {
    if (force) {
      writeFileSync(join(cwd, configRel), configText);
      writes.push(configRel);
    } else {
      skipped.push(`${configRel} already exists; pass --force to overwrite it`);
    }
  } else {
    writeFileSync(join(cwd, configRel), configText);
    writes.push(configRel);
  }

  const section = renderYuklSection(commands);
  for (const file of AGENT_DOC_FILES) {
    const path = join(cwd, file);
    if (!existsSync(path)) {
      warnings.push(
        `${file} does not exist; harness section skipped (create it to add the section)`,
      );
      continue;
    }
    const before = readFileSync(path, "utf8");
    const after = applyYuklSection(before, section).text;
    if (after !== before) {
      writeFileSync(path, after);
      writes.push(file);
    }
  }

  const workflowRel = ".github/workflows/yukl.yml";
  const workflowPath = join(cwd, workflowRel);
  const workflow = renderCiWorkflow({
    baseRef: defaultBranch,
    yuklPin: pin.pin,
    commands,
    pythonInstall,
    npmInstalls,
  });
  if (existsSync(workflowPath)) {
    if (force) {
      writeFileSync(workflowPath, workflow);
      writes.push(workflowRel);
    } else {
      skipped.push(`${workflowRel} already exists; pass --force to overwrite it`);
    }
  } else {
    mkdirSync(dirname(workflowPath), { recursive: true });
    writeFileSync(workflowPath, workflow);
    writes.push(workflowRel);
  }

  for (const dir of ["contracts", "intents"]) {
    const keep = join(cwd, ".orchestration", dir, ".gitkeep");
    if (!existsSync(keep)) {
      mkdirSync(dirname(keep), { recursive: true });
      writeFileSync(keep, "");
      writes.push(`.orchestration/${dir}/.gitkeep`);
    }
  }

  return { ok: true, writes, skipped, warnings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  "usage:",
  "  yukl render <stage-id> [--config <path>] [--task-id <id>] [--cwd <dir>]",
  "  yukl verify [<contract-path>...] [--base <git-ref>] [--timeout-ms <ms>] [--cwd <dir>]",
  "  yukl init [--cwd <dir>] [--force] [--yukl-pin <commit-sha>]",
  "            [--project-dir <rel>]... [--command <key>=<cmd>]...",
].join("\n");

function parseArgs(argv) {
  const options = { positional: [] };
  const valueFlags = new Map([
    ["--config", "config"],
    ["--task-id", "taskId"],
    ["--base", "base"],
    ["--timeout-ms", "timeoutMs"],
    ["--cwd", "cwd"],
    ["--yukl-pin", "yuklPin"],
    ["--project-dir", "projectDir"],
    ["--command", "command"],
  ]);
  const repeatableFlags = new Set(["--project-dir", "--command"]);
  const booleanFlags = new Map([["--force", "force"]]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (valueFlags.has(arg)) {
      const key = valueFlags.get(arg);
      const value = argv[++i];
      if (value === undefined) return { error: `${arg} requires a value` };
      if (repeatableFlags.has(arg)) {
        options[key] = [...(options[key] ?? []), value];
      } else {
        options[key] = value;
      }
    } else if (booleanFlags.has(arg)) {
      options[booleanFlags.get(arg)] = true;
    } else if (arg.startsWith("--")) {
      return { error: `unknown option ${arg}` };
    } else {
      options.positional.push(arg);
    }
  }
  return { options };
}

const BUILTIN_COMMANDS = new Set(["render", "verify", "init"]);
const COMMAND_NAME_RE = /^[a-z][a-z-]*$/;
const COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), "commands");

/**
 * True when `name` is shaped like a dispatchable command: lower-case ASCII
 * letters and hyphens, starting with a letter. Purely syntactic; it neither
 * touches the filesystem nor reserves the built-in commands.
 */
export function isCommandName(name) {
  return typeof name === "string" && COMMAND_NAME_RE.test(name);
}

/**
 * Load scripts/commands/<name>.js and run it. `run(argv)` receives the raw
 * arguments after the command name and returns the exit code (a number) or
 * throws. A missing module, a load failure or a thrown error all become a
 * non-zero exit code with a one-line message and never a stack trace.
 *
 * `commandsDir` is injectable so tests can point at a temporary directory;
 * the CLI resolves the default from this module's own location, never cwd.
 */
export async function dispatchCommand(name, argv, { commandsDir = COMMANDS_DIR } = {}) {
  const file = join(commandsDir, `${name}.js`);
  if (!existsSync(file)) {
    console.error(`yukl: unknown command "${name}"\n\n${USAGE}`);
    return 2;
  }
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    console.error(`yukl: command "${name}" failed to load: ${err?.message ?? err}`);
    return 1;
  }
  try {
    const code = await mod.run(argv);
    return Number.isInteger(code) ? code : 0;
  } catch (err) {
    const code = Number.isInteger(err?.exitCode) ? err.exitCode : 1;
    console.error(`yukl: command "${name}" failed: ${err?.message ?? err}`);
    return code;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const name = argv[0];
  if (name !== undefined && !name.startsWith("-") && !BUILTIN_COMMANDS.has(name)) {
    if (!isCommandName(name)) {
      console.error(`yukl: unknown command "${name}"\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    const commandsDir = process.env.YUKL_COMMANDS_DIR ?? COMMANDS_DIR;
    process.exitCode = await dispatchCommand(name, argv.slice(1), { commandsDir });
    return;
  }
  const { options, error } = parseArgs(argv);
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

  if (command === "init") {
    if (positional.length > 0) {
      console.error(`yukl: init takes no positional arguments\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    const result = runInit({
      cwd,
      force: options.force ?? false,
      yuklPin: options.yuklPin ?? null,
      projectDir: options.projectDir ?? [],
      commandOverrides: options.command ?? [],
    });
    for (const warning of result.warnings) console.error(`yukl init: warning: ${warning}`);
    for (const skip of result.skipped) console.error(`yukl init: skipped: ${skip}`);
    if (!result.ok) {
      console.error(`yukl init: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    for (const write of result.writes) console.log(`yukl init: wrote ${write}`);
    return;
  }

  console.error(`yukl: unknown command "${command}"\n\n${USAGE}`);
  process.exitCode = 2;
}

// npm's .bin shim resolves differently on every platform: a symlink to the
// script on Linux, a .cmd wrapper that re-executes node with the script path
// on Windows. `process.argv[1]` therefore names the shim (or a relative path
// to the script) rather than this file, so an endsWith("yukl.js") check never
// fired through the shim. Comparing the realpaths of import.meta.url and
// process.argv[1] resolves symlinks and wrappers alike and still refuses to
// run when the module is imported (e.g. by the test runner).
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    const scriptReal = realpathSync(fileURLToPath(import.meta.url));
    const argvReal = realpathSync(process.argv[1]);
    if (scriptReal === argvReal) return true;
    return process.platform === "win32" && scriptReal.toLowerCase() === argvReal.toLowerCase();
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main();
}
