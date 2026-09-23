#!/usr/bin/env node
// `yukl vcs-sync` publishes the Jujutsu working copy into Git before dispatch.
//
//   yukl vcs-sync [--cwd <dir>] [--bookmark <name>] [--message <text>] [--json]
//
// Orca creates a worker's worktree from a Git ref, so work that exists only in
// Jujutsu's working-copy commit (`@`) is invisible to a new worker: the worker
// branches from the branch tip and silently misses the uncommitted snapshot.
// This command closes that gap: it exports `@` to the Git branch <bookmark>
// (default `yukl-wc`) in the colocated Git repository, so
// `orca orchestration worker-start --base-branch <bookmark>` hands the worker
// exactly the state the human has on disk. `yukl run` calls the same function
// (`syncJjWorkingCopy`) before it starts any agent runtime, which makes the
// sync a dispatcher hook rather than a step someone has to remember.
//
// Nothing has to be committed by hand: Jujutsu keeps `@` in step with the
// working copy on every command, so the sync is a describe (only when `@` has
// no description yet, so a real message is never overwritten), a bookmark move
// (`--allow-backwards`, so the ref tracks `@` in both directions) and an
// export that is verified with Git before it counts. Files Jujutsu ignores
// (node_modules, .env) are not part of the snapshot.
//
// Exit codes: 0 when the working copy was published or there was no Jujutsu
// workspace to publish (a plain Git repository is not a mistake), 1 when a
// Jujutsu workspace could not be published, 2 on a usage problem. `--json`
// prints the result object on one line instead of the human summary.

import { resolve } from "node:path";
import { JJ_WC_BOOKMARK, isJjBookmarkName, syncJjWorkingCopy } from "../yukl.js";

const USAGE = [
  "usage:",
  "  yukl vcs-sync [--cwd <dir>] [--bookmark <name>] [--message <text>] [--json]",
].join("\n");

/**
 * Parse the raw arguments after `vcs-sync`. Returns `{ error }` for a usage
 * problem (the caller exits 2) or the parsed options. Unknown flags, missing
 * values and stray positionals are refused, so a typo never slips through; the
 * bookmark name is checked here as well, before jj is spawned at all.
 */
export function parseArgs(argv) {
  const options = { cwd: null, bookmark: JJ_WC_BOOKMARK, message: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--cwd" || arg === "--bookmark" || arg === "--message") {
      const value = argv[++i];
      if (value === undefined) return { error: `${arg} requires a value` };
      options[arg === "--cwd" ? "cwd" : arg === "--bookmark" ? "bookmark" : "message"] = value;
      continue;
    }
    if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
    return { error: `unexpected argument "${arg}"` };
  }
  if (!isJjBookmarkName(options.bookmark)) {
    return { error: `--bookmark "${options.bookmark}" is not a valid bookmark name` };
  }
  return options;
}

/** The human summary of a sync result. */
function describe(result, cwd) {
  if (!result.synced) return `yukl vcs-sync: ${result.reason} in ${cwd}; nothing to publish`;
  const action = result.moved ? "published" : "already published";
  const described = result.described ? "described and " : "";
  return (
    `yukl vcs-sync: ${described}${action} ${result.commit.slice(0, 12)} ` +
    `as ${result.ref} in ${result.jjRoot}`
  );
}

/**
 * Run `yukl vcs-sync`. Returns the process exit code: 2 on a usage problem, 1
 * when a Jujutsu workspace exists but its working copy could not be published,
 * 0 otherwise. `--json` prints the result object for a calling hook.
 */
export function run(argv = []) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`yukl vcs-sync: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const cwd = resolve(parsed.cwd ?? process.cwd());
  const options = { cwd, bookmark: parsed.bookmark };
  if (parsed.message !== null) options.message = parsed.message;
  const result = syncJjWorkingCopy(options);

  if (parsed.json) {
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }
  if (!result.ok) {
    console.error(`yukl vcs-sync: ${result.error}`);
    return 1;
  }
  console.log(describe(result, cwd));
  return 0;
}
