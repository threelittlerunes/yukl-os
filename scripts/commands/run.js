#!/usr/bin/env node
// `yukl run` drives one task through the lifecycle engine.
//
//   yukl run <task_id> [--unattended] [--once] [--cwd <dir>] [--base <git-ref>]
//
// The command is the composition root of the engine: it loads the real event
// log, stage machine, policy, anchors, path enforcement and diagnosis, and the
// runtime and VCS adapters named in the `lifecycle` block of yukl.config.json.
// With `--once` it takes a single engine step; otherwise it loops until the
// lifecycle blocks, needs a human, escalates or reaches a terminal stage. The
// exit code is 0 when the run advanced or stopped cleanly, 1 on a refusal or an
// error, and 2 on a usage problem.
//
// The lifecycle block and the policy are read from the base ref when one is
// given, so a task branch cannot name its own runtimes, and from the working
// tree otherwise, which makes a bare run a local preview rather than a trust
// boundary. `--unattended` is refused before any adapter is started unless
// every run limit is a positive integer: an unbounded run must stay attended.
// An unattended run waits for a running stage instead of stopping on it, and
// stops only when the task is terminal, needs a human, escalates or breaches a
// run limit (which appends an `enforcement` event); an attended run keeps the
// step-capped loop it has always had.
//
// An agent stage is judged where its worker committed. A runtime adapter may
// implement the optional `workspace(handle) -> { path } | null`; when the
// runtime of the stage's adapter does, `yukl run` reads the stage's handle from
// the task log, resolves that checkout's `HEAD` and uses it for the stage's
// anchor and for path enforcement instead of the orchestrator checkout's HEAD
// and branch. An Orca worker commits in its own git worktree, so only that
// commit names the work being judged; a workspace or HEAD that cannot be
// resolved refuses the stage with `R-NEEDS-HUMAN` (the anchor refuses too, for
// `R-NO-ANCHOR`), never falling back to the wrong commit. A runtime without
// `workspace` - the fake adapter - keeps the previous behaviour exactly.
//
// In a colocated Jujutsu workspace every agent start publishes the Jujutsu
// working copy into Git first (see withWorkingCopySync): Orca branches a
// worker's worktree from a Git ref, and work that lives only in the
// working-copy commit would otherwise be invisible to the agent.
// In a jj workspace the worker therefore branches from the published
// working-copy ref even when --base is given (--base governs only config,
// policy and enforcement).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { anchorAt } from "../lifecycle/anchors.js";
import { diagnose } from "../lifecycle/diagnose.js";
import { runUntilBlocked, step as engineStep } from "../lifecycle/engine.js";
import { pathEnforcement } from "../lifecycle/enforce.js";
import { appendEvent, headHash, readEvents } from "../lifecycle/events.js";
import {
  RUN_LIMIT_KEYS,
  loadPolicy,
  requiresHuman as policyRequiresHuman,
  unattendedAllowed,
} from "../lifecycle/policy.js";
import { loadAdapter } from "../lifecycle/runtime.js";
import * as stages from "../lifecycle/stages.js";
import { autonomyLevel, trackRecord } from "../lifecycle/track.js";
import {
  CONTRACTS_DIR,
  JJ_WC_BOOKMARK,
  jjWorkspaceRoot,
  syncJjWorkingCopy,
  yuklConfigViolations,
} from "../yukl.js";
import { lifecycleViolations } from "../validators/lifecycle.js";

const CONFIG_FILE = "yukl.config.json";
const DEFAULT_BASE = "main";
const DEFAULT_WORKTREE_REF = "HEAD";
const FALLBACK_RUNTIME_ID = "runtime";

const RUNTIME_FACTORY_RE = /^create[A-Za-z0-9]*Runtime$/;
const VCS_FACTORY_RE = /^create[A-Za-z0-9]*Vcs$/;

const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

// A step or run outcome that is not a refusal. `blocked` covers a clean stop
// that asks for a human; `started` and `waiting` are progress, not failure.
const CLEAN_STEP = new Set(["started", "advanced", "waiting", "blocked", "terminal"]);
const CLEAN_RUN = new Set(["terminal", "blocked", "waiting"]);

/**
 * Parse the arguments after `run`. Returns `{ error }` for a usage problem
 * (the caller exits 2) or the parsed options. Unknown flags and extra
 * positionals are refused, so a typo never slips through.
 */
function parseArgs(argv) {
  const options = { unattended: false, once: false, cwd: null, base: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--unattended" || arg === "--once") {
      options[arg === "--unattended" ? "unattended" : "once"] = true;
      continue;
    }
    if (arg === "--cwd" || arg === "--base") {
      const value = argv[++i];
      if (value === undefined) return { error: `${arg} requires a value` };
      options[arg === "--cwd" ? "cwd" : "base"] = value;
      continue;
    }
    if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
    positional.push(arg);
  }
  if (positional.length === 0) return { error: "missing <task_id>" };
  if (positional.length > 1) return { error: `unexpected argument "${positional[1]}"` };
  if (!TASK_ID_RE.test(positional[0])) {
    return { error: `task id "${positional[0]}" must be a lower-case path segment` };
  }
  return { taskId: positional[0], ...options };
}

/** Read yukl.config.json from the base ref (via git show) or the working tree. */
function readConfigText({ cwd, base }) {
  if (base != null) {
    const shown = spawnSync("git", ["show", `${base}:${CONFIG_FILE}`], {
      cwd,
      encoding: "utf8",
    });
    if (shown.status !== 0) {
      const detail = (shown.stderr || "").trim();
      return {
        ok: false,
        error: `cannot read ${CONFIG_FILE} at ${base}${detail ? `: ${detail}` : ""}`,
      };
    }
    return { ok: true, text: shown.stdout, source: `${CONFIG_FILE} at ${base}` };
  }
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) {
    return { ok: false, error: `no ${CONFIG_FILE} in ${cwd}` };
  }
  return { ok: true, text: readFileSync(path, "utf8"), source: `${CONFIG_FILE} (working tree)` };
}

/** The id of the first export shaped like a factory for `pattern`. */
function findFactory(mod, pattern) {
  for (const key of Object.keys(mod)) {
    if (pattern.test(key) && typeof mod[key] === "function") return mod[key];
  }
  return null;
}

/**
 * The source stage of an agent edge id, e.g. `advance:scope->plan` -> "scope".
 * Returns null for anything that is not an advance edge.
 */
function edgeSource(edgeId) {
  const match = /^advance:([^>]+)->/.exec(String(edgeId));
  return match ? match[1] : null;
}

/**
 * Map an engine edge id to the transition id yukl.policy.json knows. The stage
 * machine names agent edges `advance:<from>-><to>`; the policy names the
 * post-merge transition `merge-implementation-pr` and every other stage
 * advance `advance-stage-on-gate-pass`. Anything else is returned unchanged,
 * so an unknown id stays unknown and the policy fails closed.
 */
export function mapToPolicyId(edgeId) {
  if (edgeId === "advance:integrate->done") return "merge-implementation-pr";
  if (edgeSource(edgeId) !== null) return "advance-stage-on-gate-pass";
  return edgeId;
}

/** The commit at `ref`, or null when it is not a 40-hex sha. */
function headCommit(cwd, ref) {
  const result = spawnSync("git", ["rev-parse", ref], { cwd, encoding: "utf8" });
  if (result.status !== 0) return null;
  const sha = (result.stdout || "").trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

/** The current branch name, or null on a detached HEAD or unknown ref. */
function currentBranch(cwd) {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const branch = (result.stdout || "").trim();
  return branch === "" || branch === "HEAD" ? null : branch;
}

/** The 40-hex HEAD of the git checkout at `path`, or null. */
function worktreeHead(path) {
  const result = spawnSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  const sha = (result.stdout || "").trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

/**
 * The `handle` on the task log's last `stage_started` event for `stage`, read
 * from the log itself rather than from the agent. Returns null when the stage
 * has no recorded start or the recorded handle is not a non-empty string.
 */
function lastStageHandle(stateDir, taskId, stage) {
  let handle = null;
  for (const event of readEvents(stateDir, taskId).events) {
    if (event?.type !== "stage_started" || event?.data?.stage !== stage) continue;
    const value = event?.data?.handle;
    if (typeof value === "string" && value !== "") handle = value;
  }
  return handle;
}

/**
 * Resolve the workspace and HEAD of the worker that ran `stage`, when its
 * runtime implements the optional `workspace` method. A runtime without that
 * method yields `{ implements: false }`, which is today's behaviour: the run
 * judges the orchestrator checkout. When it does implement it, the result is
 * `{ implements: true, ok, path, sha }` or `{ implements: true, ok: false,
 * error }` - an unresolvable workspace is never silently replaced by the
 * orchestrator's HEAD.
 */
function resolveStageWorkspace({ runtimes, stateDir }, stage, taskId) {
  const runtime = runtimes.get(stage);
  if (runtime === null || runtime === undefined || typeof runtime.workspace !== "function") {
    return { implements: false };
  }
  const handle = lastStageHandle(stateDir, taskId, stage);
  if (handle === null) {
    return {
      implements: true,
      ok: false,
      error: `no stage_started handle is recorded for ${stage}`,
    };
  }
  let shown;
  try {
    shown = runtime.workspace(handle);
  } catch (err) {
    return {
      implements: true,
      ok: false,
      error: `workspace(${handle}) threw: ${err?.message ?? err}`,
    };
  }
  const path = shown !== null && typeof shown === "object" ? shown.path : null;
  if (typeof path !== "string" || path === "") {
    return {
      implements: true,
      ok: false,
      error: `worker-show reported no worktree path for ${handle}`,
    };
  }
  const sha = worktreeHead(path);
  if (sha === null) {
    return { implements: true, ok: false, error: `git -C ${path} rev-parse HEAD failed` };
  }
  return { implements: true, ok: true, path, sha };
}

/**
 * Resolve a completed stage's anchor from the real anchors module: the last
 * commit that touched the task's contract path. A stage whose contract is not
 * committed yet anchors at the branch tip instead, which keeps the provenance
 * honest while an agent stage is still in flight.
 *
 * For a stage whose runtime reports the worker's workspace (section 4.11 of
 * docs/YUKL_ARCHITECTURE.md), the anchor is resolved in that checkout at its
 * HEAD, never at the orchestrator checkout's HEAD: the worker commits in its
 * own worktree, so only the worker's HEAD names the work being judged. A
 * workspace that cannot be resolved refuses the anchor outright (the engine
 * then blocks with `R-NO-ANCHOR`) rather than anchoring the wrong commit.
 */
function makeAnchors({ cwd, ref, runtimes, stateDir }) {
  return {
    anchorStage: async (stage, taskId) => {
      const relPath = `${CONTRACTS_DIR}/${taskId}.json`;
      const worker = resolveStageWorkspace({ runtimes, stateDir }, stage, taskId);
      if (worker.implements) {
        if (!worker.ok) return { ok: false };
        const anchored = anchorAt(worker.path, worker.sha, relPath);
        if (anchored.ok) {
          return { ok: true, anchor: { path: anchored.path, commit: anchored.commit } };
        }
        return { ok: true, anchor: { path: relPath, commit: worker.sha } };
      }
      const anchored = anchorAt(cwd, ref, relPath);
      if (anchored.ok) {
        return { ok: true, anchor: { path: anchored.path, commit: anchored.commit } };
      }
      const commit = headCommit(cwd, ref);
      if (commit === null) return { ok: false };
      return { ok: true, anchor: { path: relPath, commit } };
    },
  };
}

/** The adapter name of the stage an agent edge leaves, or null. */
function runtimeNameFor(edgeId, lifecycle) {
  const from = edgeSource(edgeId);
  const adapter = from === null ? null : lifecycle.runtimes?.[from]?.adapter;
  return typeof adapter === "string" && adapter !== "" ? adapter : null;
}

/**
 * The human-authority policy consulted by the stage machine. The autonomy
 * level is earned from the audits recorded for the edge's runtime, and the
 * edge id is mapped onto the policy's transition ids first, so an unmapped id
 * reaches the policy untouched and is refused there.
 */
function makeRequiresHuman({ policy, stateDir, taskId, lifecycle }) {
  return (edgeId) => {
    const log = readEvents(stateDir, taskId);
    const level = autonomyLevel(trackRecord(log.events, runtimeNameFor(edgeId, lifecycle)), policy);
    return policyRequiresHuman(policy, mapToPolicyId(edgeId), level);
  };
}

/** The per-stage dispatch context: the agent, its env, the worktree and a brief. */
function makeDispatch({ lifecycle, cwd, base, ref }) {
  return (stage, taskId) => {
    if (stage === "integrate") {
      const target = base ?? DEFAULT_BASE;
      return {
        actor: stage,
        ref: ref ?? DEFAULT_WORKTREE_REF,
        base: target,
        anchor: { path: target, commit: headCommit(cwd, ref ?? DEFAULT_WORKTREE_REF) ?? "" },
      };
    }
    const entry = lifecycle.runtimes?.[stage];
    if (entry === undefined || entry === null) return {};
    return {
      actor: entry.agent,
      env: { YUKL_AGENT: entry.agent },
      worktree: cwd,
      spec: `Stage ${stage} for task ${taskId} run by agent ${entry.agent}.`,
    };
  };
}

/** Wrap the real failure diagnosis as the engine's `decide` dependency. */
function makeDecide(policy) {
  return (observation, history) => {
    const prior = Array.isArray(history?.decisions) ? history.decisions : [];
    const records = prior.map((decision) => ({
      stage: history?.stage,
      category: decision?.category,
      decision,
      intervention: decision?.intervention,
      inputHash: decision?.inputHash,
    }));
    return diagnose(observation, records, policy);
  };
}

/**
 * Run the real path enforcement for the completed stage. A stage whose runtime
 * reports the worker's workspace is enforced against the commit the worker made
 * there (its HEAD), not against the orchestrator checkout's branch; the base ref
 * stays the trust root for the intent. A workspace that cannot be resolved is
 * refused with `R-NEEDS-HUMAN` and a violation naming the reason, so an
 * unreadable worker record stops the stage instead of passing it silently
 * against the wrong commit. A runtime without `workspace` keeps today's
 * behaviour: the task branch of `cwd`, enforced only when `--base` is given.
 */
function makeEnforce({ cwd, base, taskId, runtimes, stateDir }) {
  return async ({ stage, taskId: stageTaskId }) => {
    const id = typeof stageTaskId === "string" && stageTaskId !== "" ? stageTaskId : taskId;
    const worker = resolveStageWorkspace({ runtimes, stateDir }, stage, id);
    if (!worker.implements) {
      if (base == null) return { ok: true, violations: [] };
      const branch = currentBranch(cwd) ?? DEFAULT_WORKTREE_REF;
      const outcome = pathEnforcement({ cwd, base, taskId: id, branch });
      return { ok: outcome.ok, violations: outcome.violations, rule: outcome.rule };
    }
    if (!worker.ok) {
      return {
        ok: false,
        rule: stages.RULES.NEEDS_HUMAN,
        violations: [`worker workspace unresolvable: ${worker.error}`],
      };
    }
    if (base == null) return { ok: true, violations: [] };
    const outcome = pathEnforcement({ cwd, base, taskId: id, branch: worker.sha });
    return { ok: outcome.ok, violations: outcome.violations, rule: outcome.rule };
  };
}

/**
 * Wrap a runtime so every agent start first publishes the Jujutsu working copy
 * into Git. Orca branches a worker's worktree from a Git ref, so a base ref
 * that predates the human's working-copy commit hands the agent a stale tree
 * without any error. The sync runs immediately before the start it guards, so
 * a long run that dispatches several stages publishes the state as it is at
 * each dispatch; a sync that cannot be proven refuses the dispatch (a worker
 * branching from an unknown state is the failure this exists to prevent). The
 * sync publishes a ref and never edits `@`, so a work-in-progress commit the
 * human left undescribed is handed over exactly as it is. `status`, `result`
 * and `stop` stay on the wrapped runtime untouched.
 */
export function withWorkingCopySync(runtime, { cwd, bookmark }) {
  const syncFirst = Object.create(runtime);
  syncFirst.start = function start(dispatch) {
    const sync = syncJjWorkingCopy({ cwd, bookmark });
    if (!sync.ok) throw new Error(`refusing to dispatch an agent: ${sync.error}`);
    return runtime.start(dispatch);
  };
  return syncFirst;
}

/** Load the runtime adapter for one lifecycle entry and build its runtime. */
async function defaultCreateRuntime(entry, { adaptersDir, loadAdapterFn, cwd, jjBase = null }) {
  const mod = await loadAdapterFn(entry.adapter, { adaptersDir });
  const factory = findFactory(mod, RUNTIME_FACTORY_RE);
  if (factory === null) {
    throw new Error(`adapter "${entry.adapter}" exports no runtime factory`);
  }
  const runtime = factory({ agent: entry.agent, baseBranch: jjBase ?? undefined });
  return jjBase === null ? runtime : withWorkingCopySync(runtime, { cwd, bookmark: jjBase });
}

/** Load the VCS adapter named by the lifecycle block and build it. */
async function defaultCreateVcs(name, { cwd, base, allowlist, adaptersDir, loadAdapterFn }) {
  const mod = await loadAdapterFn(name, { adaptersDir });
  const factory = findFactory(mod, VCS_FACTORY_RE);
  if (factory === null) {
    throw new Error(`adapter "${name}" exports no VCS factory`);
  }
  return factory({ cwd, repoDir: cwd, base, commands: allowlist });
}

/** Preload every configured runtime, so `runtime(stage)` stays synchronous. */
async function preloadRuntimes({ lifecycle, context }) {
  const runtimes = new Map();
  for (const [stage, entry] of Object.entries(lifecycle.runtimes ?? {})) {
    runtimes.set(stage, await context.createRuntime(entry, context));
  }
  return runtimes;
}

/** The single-line summary of a step or run outcome. */
function describeOutcome(outcome) {
  const parts = [`yukl run: ${outcome.status}`];
  if (outcome.stage) parts.push(`at ${outcome.stage}`);
  if (outcome.from && outcome.to) parts.push(`${outcome.from} -> ${outcome.to}`);
  if (outcome.rule) parts.push(`(${outcome.rule})`);
  const limit = outcome.limit;
  if (limit && typeof limit === "object") {
    parts.push(`(${limit.name} ${limit.observed} >= ${limit.max})`);
  }
  return parts.join(" ");
}

/**
 * Run `yukl run`. Returns the process exit code. `overrides` lets a caller
 * (a test) replace the working directory, the adapter loader, the runtime and
 * VCS factories, the clock and the unattended loop's `sleep` and
 * `pollIntervalMs`; the defaults are the real modules and the adapters under
 * `<cwd>/scripts/adapters`, so production is never special-cased.
 */
export async function run(argv = [], overrides = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`yukl run: ${parsed.error}`);
    return 2;
  }
  const { taskId } = parsed;
  const cwd = resolve(overrides.cwd ?? parsed.cwd ?? process.cwd());
  const base = parsed.base ?? null;

  try {
    const configText = readConfigText({ cwd, base });
    if (!configText.ok) {
      console.error(`yukl run: ${configText.error}`);
      return 1;
    }
    let config;
    try {
      config = JSON.parse(configText.text);
    } catch (err) {
      console.error(`yukl run: ${configText.source} is not valid JSON: ${err.message}`);
      return 1;
    }
    const schemaErrors = yuklConfigViolations(config);
    if (schemaErrors.length > 0) {
      console.error(`yukl run: ${configText.source} schema: ${schemaErrors.join("; ")}`);
      return 1;
    }
    const lifecycle = config.lifecycle;
    if (lifecycle === undefined || lifecycle === null) {
      console.error(`yukl run: ${configText.source} has no lifecycle block`);
      return 1;
    }
    const blockErrors = lifecycleViolations(lifecycle, cwd);
    if (blockErrors.length > 0) {
      console.error(`yukl run: lifecycle block: ${blockErrors.join("; ")}`);
      return 1;
    }

    const loaded = overrides.loadPolicy ? overrides.loadPolicy() : loadPolicy({ cwd, base });
    if (!loaded.ok) {
      console.error(`yukl run: ${loaded.errors.join("; ")}`);
      return 1;
    }
    const policy = loaded.policy;

    if (parsed.unattended && !unattendedAllowed(policy)) {
      const unset = RUN_LIMIT_KEYS.filter(
        (key) => !(Number.isInteger(policy?.budgets?.[key]) && policy.budgets[key] > 0),
      );
      console.error(
        `yukl run: --unattended is refused while these run limits are unset: ${unset.join(", ")}; set each to a positive integer in yukl.policy.json to run unattended`,
      );
      return 1;
    }
    // The run limits bound one run whatever its mode; null means unset, and an
    // unattended run has already been refused above unless both are set.
    const limits = {
      maxWallMinutesPerRun: policy?.budgets?.maxWallMinutesPerRun ?? null,
      maxAgentStartsPerRun: policy?.budgets?.maxAgentStartsPerRun ?? null,
    };

    const stateDir = resolve(cwd, lifecycle.stateDir);
    const ref = currentBranch(cwd);
    // A colocated Jujutsu workspace reports itself here, and an unresolvable
    // one reports an error instead of passing as plain Git; either way the
    // runtimes are built against the synced working-copy ref rather than the
    // branch tip (the sync itself refuses a dispatch it cannot prove).
    const jjWorkspace = jjWorkspaceRoot(cwd);
    const jjBase = jjWorkspace.root === null && jjWorkspace.error === null ? null : JJ_WC_BOOKMARK;
    const context = {
      cwd,
      jjBase,
      adaptersDir: resolve(overrides.adaptersDir ?? join(cwd, "scripts", "adapters")),
      loadAdapterFn: overrides.loadAdapter ?? loadAdapter,
      createRuntime: overrides.createRuntime ?? defaultCreateRuntime,
    };
    const runtimes = await preloadRuntimes({ lifecycle, context });
    const vcs =
      overrides.createVcs !== undefined
        ? await overrides.createVcs(lifecycle.vcs, {
            ...context,
            base,
            allowlist: config.allowlist,
          })
        : await defaultCreateVcs(lifecycle.vcs, {
            ...context,
            base,
            allowlist: config.allowlist,
          });

    // A runtime that reports the worker's workspace - the Orca adapter does,
    // the fake adapter does not - makes the run judge the commit the worker
    // made in its own worktree: the anchor and path enforcement follow that
    // checkout's HEAD instead of the orchestrator checkout's HEAD and branch,
    // and a workspace that cannot be resolved blocks the stage rather than
    // anchoring the wrong commit.
    const reportsWorkspace = [...runtimes.values()].some(
      (runtime) =>
        runtime !== null && runtime !== undefined && typeof runtime.workspace === "function",
    );

    const deps = {
      events: { dir: stateDir, readEvents, appendEvent, headHash },
      stages,
      anchors:
        overrides.anchors ?? makeAnchors({ cwd, ref: DEFAULT_WORKTREE_REF, runtimes, stateDir }),
      requiresHuman: makeRequiresHuman({ policy, stateDir, taskId, lifecycle }),
      runtime: (stage) => runtimes.get(stage) ?? null,
      runtimeId: (stage) => lifecycle.runtimes?.[stage]?.adapter ?? FALLBACK_RUNTIME_ID,
      decide: makeDecide(policy),
      vcs,
      dispatch: overrides.dispatch ?? makeDispatch({ lifecycle, cwd, base, ref }),
      clock: overrides.clock,
    };
    if (base != null || reportsWorkspace) {
      deps.enforce = makeEnforce({ cwd, base, taskId, runtimes, stateDir });
    }

    if (parsed.once) {
      const outcome = await engineStep({ taskId, deps });
      console.log(describeOutcome(outcome));
      return CLEAN_STEP.has(outcome.status) ? 0 : 1;
    }
    const result = await runUntilBlocked({
      taskId,
      deps,
      unattended: parsed.unattended,
      limits,
      sleep: overrides.sleep,
      pollIntervalMs: overrides.pollIntervalMs,
    });
    console.log(describeOutcome(result));
    return CLEAN_RUN.has(result.status) ? 0 : 1;
  } catch (err) {
    console.error(`yukl run: ${err?.message ?? err}`);
    return 1;
  }
}
