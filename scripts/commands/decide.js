#!/usr/bin/env node
// `yukl decide` records a human decision on a task's lifecycle event log.
//
//   yukl decide <pause|resume|override|stop|approve> --task <id> --by <name>
//     --reason <text> [--to <stage>] [--state-dir <dir>]
//
// Exactly one `human_decision` event is appended to <state-dir>/<task-id>.jsonl
// with the actor `human:<by>`. The event records who (`by`), what (the decision
// and `to` when there is one), why (`reason`) and the seq it applied to
// (`appliedAtSeq`, null for an empty log). `override` and `stop` also write the
// target stage to `data.to`, so foldState reflects the move. `--state-dir`
// defaults to `.orchestration/state` resolved from the working directory.
//
// Nothing is appended unless the transition accepts the decision: a decision on
// a task whose folded state is terminal exits 1 naming the rule. A dispatched
// agent holds no human authority, so any call with YUKL_DISPATCH_ID set exits 1
// as well. Usage problems (bad flags, missing values, an unknown decision or a
// bad --to) exit 2. In every refused case the log is left byte for byte intact.

import { resolve } from "node:path";
import { appendEvent, foldState, readEvents } from "../lifecycle/events.js";
import { STAGES, initialState, transition } from "../lifecycle/stages.js";

const DECISIONS = Object.freeze(["pause", "resume", "override", "stop", "approve"]);
const OPTIONS = Object.freeze(["--task", "--by", "--reason", "--to", "--state-dir"]);
const DEFAULT_STATE_DIR = ".orchestration/state";

/**
 * Parse the raw arguments after `decide`. Returns `{ error }` for a usage
 * problem (the caller exits 2) or `{ decision, task, by, reason, to, stateDir }`.
 * Unknown flags and any bare positional after the decision are refused, so a
 * typo can never be silently ignored.
 */
function parseArgs(argv) {
  if (argv.length === 0 || argv[0].startsWith("-")) {
    return { error: "missing decision" };
  }
  const decision = argv[0];
  if (!DECISIONS.includes(decision)) {
    return { error: `unknown decision "${decision}"` };
  }

  const values = { task: null, by: null, reason: null, to: null, stateDir: null };
  const names = {
    "--task": "task",
    "--by": "by",
    "--reason": "reason",
    "--to": "to",
    "--state-dir": "stateDir",
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) return { error: `unexpected argument "${arg}"` };
    if (!OPTIONS.includes(arg)) return { error: `unknown option "${arg}"` };
    if (i + 1 >= argv.length) return { error: `missing value for ${arg}` };
    values[names[arg]] = argv[++i];
  }

  for (const [key, flag] of [
    ["task", "--task"],
    ["by", "--by"],
    ["reason", "--reason"],
  ]) {
    if (values[key] === null || values[key].trim() === "") {
      return { error: `missing required option ${flag}` };
    }
  }
  if (decision === "override") {
    if (values.to === null || values.to.trim() === "") {
      return { error: "override requires --to <stage>" };
    }
    if (!STAGES.includes(values.to)) {
      return { error: `--to "${values.to}" is not a stage in ${STAGES.join(", ")}` };
    }
  }
  return { decision, ...values };
}

/**
 * Build the `human_decision` event for `transition` (which reads a root-level
 * `stage` or `action`) while keeping only the decision fields in `data` (which
 * is all `appendEvent` persists). Returns the event to append.
 */
function buildEvent(parsed, appliedAtSeq, currentStage) {
  const data = {
    decision: parsed.decision,
    by: parsed.by,
    reason: parsed.reason,
    appliedAtSeq,
  };
  const event = { type: "human_decision", actor: `human:${parsed.by}`, data };
  if (parsed.decision === "override") {
    event.stage = parsed.to;
    data.to = parsed.to;
  } else if (parsed.decision === "stop") {
    event.action = "stop";
    data.action = "stop";
    data.to = "stopped";
  } else if (parsed.decision === "pause" || parsed.decision === "resume") {
    event.action = parsed.decision;
    data.action = parsed.decision;
  } else {
    // approve: a human re-affirms the current stage, so it does not move.
    event.stage = currentStage;
  }
  return event;
}

/**
 * Run `yukl decide`. Returns the process exit code. A dispatched agent is
 * refused before any parsing; a usage problem returns 2; a transition refusal
 * returns 1; success appends the event and returns 0.
 */
export function run(argv = []) {
  if (process.env.YUKL_DISPATCH_ID !== undefined) {
    console.error(
      "yukl decide: refused, YUKL_DISPATCH_ID is set so this caller is an agent, not a human",
    );
    return 1;
  }

  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`yukl decide: ${parsed.error}`);
    return 2;
  }

  const stateDir = resolve(parsed.stateDir ?? DEFAULT_STATE_DIR);
  const log = readEvents(stateDir, parsed.task);
  const state = foldState(log);
  const appliedAtSeq = log.events.length === 0 ? null : log.events.length - 1;
  const currentStage = typeof state.stage === "string" ? state.stage : initialState().stage;
  const event = buildEvent(parsed, appliedAtSeq, currentStage);

  const outcome = transition(initialState({ stage: currentStage }), event);
  if (!outcome.ok) {
    console.error(`yukl decide: refused by ${outcome.rule}`);
    return 1;
  }

  appendEvent(stateDir, parsed.task, event);
  return 0;
}
