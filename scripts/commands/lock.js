#!/usr/bin/env node
// `yukl lock` drives the advisory lock broker (scripts/lifecycle/locks.js).
//
//   yukl lock hold <name> [--task <id>] [--locks-dir <dir>] -- <command> [args...]
//   yukl lock status <name> [--locks-dir <dir>] [--json]
//   yukl lock release <name> [--locks-dir <dir>] [--force]
//
// `hold` is the one that matters for tandem concurrency: it acquires
// `<locks-dir>/<name>.lock`, runs the command while holding it, and releases
// the lock however the command ends (a `finally`, so a failed or killed command
// still releases). A held lock exits 1 and names the holder; a stale lock whose
// owner process is gone is reclaimed and the command runs. `status` and
// `release` are the inspection and cleanup verbs: `release` refuses to remove a
// lock held by another live process unless `--force` is passed.
//
// `--locks-dir` defaults to `.orchestration/locks` resolved from the working
// directory. Exit codes: 0 when the command (or the verb) succeeded, the
// command's own code when it failed, 1 on a refused lock, and 2 on a usage
// problem.

import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { resolve } from "node:path";
import {
  acquireLock,
  inspectLock,
  isLockName,
  isProcessAlive,
  releaseLock,
} from "../lifecycle/locks.js";

const DEFAULT_LOCKS_DIR = ".orchestration/locks";
const VERBS = Object.freeze(["hold", "status", "release"]);

/**
 * Parse the raw arguments after `lock`. Returns `{ error }` for a usage problem
 * (the caller exits 2) or `{ verb, name, task, locksDir, force, json, command }`
 * where `command` is the argument list after `--` (required by `hold` and
 * refused by the other verbs).
 */
function parseArgs(argv) {
  if (argv.length === 0 || argv[0].startsWith("-")) {
    return { error: "missing <hold|status|release>" };
  }
  const verb = argv[0];
  if (!VERBS.includes(verb)) return { error: `unknown verb "${verb}"` };

  const options = { locksDir: null, task: null, force: false, json: false, command: null };
  const names = { "--locks-dir": "locksDir", "--task": "task" };
  let i = 1;
  if (i >= argv.length || argv[i].startsWith("-")) return { error: "missing <name>" };
  const name = argv[i];
  if (!isLockName(name)) return { error: `"${name}" is not a valid lock name` };
  i += 1;

  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      options.command = argv.slice(i + 1);
      break;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (Object.hasOwn(names, arg)) {
      const value = argv[++i];
      if (value === undefined) return { error: `${arg} requires a value` };
      options[names[arg]] = value;
      continue;
    }
    return { error: `unknown option ${arg}` };
  }

  if (verb === "hold" && (options.command === null || options.command.length === 0)) {
    return { error: "hold requires a command after --" };
  }
  if (verb !== "hold" && options.command !== null) {
    return { error: `${verb} takes no command after --` };
  }
  return { verb, name, ...options };
}

/** The one-line owner description printed for a held or reclaimed lock. */
export function describeHolder(owner) {
  const task = typeof owner.task === "string" && owner.task !== "" ? ` task ${owner.task}` : "";
  return `pid ${owner.pid} on ${owner.host}${task} since ${owner.at}`;
}

/** Print the state of a lock in the human or JSON form. */
function printStatus(name, state, json) {
  if (json) {
    console.log(JSON.stringify({ name, ...state }));
    return;
  }
  if (state.state === "absent") {
    console.log(`lock ${name}: absent`);
    return;
  }
  if (state.state === "unreadable") {
    console.log(`lock ${name}: unreadable (${state.detail})`);
    return;
  }
  console.log(`lock ${name}: held by ${describeHolder(state.owner)}`);
}

/**
 * Run `yukl lock`. Returns the process exit code. `overrides` lets a caller
 * (a test) inject the lock directory, the spawn used by `hold`, the process id,
 * host, clock and liveness check; the defaults are the real ones.
 */
export function run(argv = [], overrides = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`yukl lock: ${parsed.error}`);
    return 2;
  }
  const { verb, name } = parsed;
  const locksDir = resolve(overrides.locksDir ?? parsed.locksDir ?? DEFAULT_LOCKS_DIR);
  const clock = overrides.clock ?? (() => new Date());
  const identity = {
    dir: locksDir,
    name,
    pid: overrides.pid ?? process.pid,
    host: overrides.host ?? hostname(),
    clock,
    alive: overrides.alive ?? isProcessAlive,
  };

  if (verb === "status") {
    const state = inspectLock(locksDir, name);
    printStatus(name, state, parsed.json);
    return state.state === "unreadable" ? 1 : 0;
  }

  if (verb === "release") {
    const released = releaseLock({
      dir: locksDir,
      name,
      force: parsed.force,
      pid: parsed.force ? null : identity.pid,
    });
    if (!released.ok) {
      console.error(`yukl lock: cannot release ${name}: ${released.reason}`);
      return 1;
    }
    console.log(released.released ? `lock ${name}: released` : `lock ${name}: absent`);
    return 0;
  }

  const acquired = acquireLock({ ...identity, task: parsed.task });
  if (!acquired.ok) {
    if (acquired.reason === "held") {
      console.error(
        `yukl lock: ${name} is held by ${describeHolder(acquired.holder)}; retry once it is released`,
      );
      return 1;
    }
    console.error(`yukl lock: cannot acquire ${name}: ${acquired.reason} (${acquired.detail})`);
    return 1;
  }
  if (acquired.reclaimed) {
    console.log(`lock ${name}: reclaimed from ${describeHolder(acquired.holder)}`);
  } else {
    console.log(`lock ${name}: acquired`);
  }

  const spawn = overrides.spawn ?? spawnSync;
  try {
    const [command, ...args] = parsed.command;
    const result = spawn(command, args, {
      cwd: overrides.cwd ?? process.cwd(),
      stdio: "inherit",
      env: process.env,
    });
    const status = Number.isInteger(result?.status) ? result.status : 1;
    if (result?.error) {
      console.error(
        `yukl lock: ${command} failed to start: ${result.error.message ?? result.error}`,
      );
      return 1;
    }
    return status;
  } finally {
    const released = releaseLock({ dir: locksDir, name, pid: identity.pid });
    if (!released.ok) {
      console.error(`yukl lock: could not release ${name}: ${released.reason}`);
    }
  }
}
