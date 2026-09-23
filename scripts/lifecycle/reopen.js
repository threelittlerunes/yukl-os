#!/usr/bin/env node
// Reopening an earlier stage when an audit finding requires an amended
// artefact (v2-w2).
//
// An audit can find that an artefact from an earlier stage is wrong or
// incomplete. The lifecycle then has to go back far enough to amend it, and it
// may only carry on once the amended artefact is anchored on the base line.
// This module holds the two halves of that move and nothing else:
//
//   reopen(state, finding)         the event that rewinds the lifecycle, pure
//                                  over the state it is handed;
//   reopenedStageComplete(input)   the proof that the amended artefact is now
//                                  anchored at the base ref.
//
// The first refuses a target that is not intent, scope or plan, and a target
// that is not earlier than the current stage. The second reads Git through the
// helpers in anchors.js, so an amendment committed only on a PR branch - and
// never merged into the base ref - cannot complete the reopened stage.

import { anchorAt, isAncestor } from "./anchors.js";
import { STAGES } from "./stages.js";

export const R_REOPEN = "R-REOPEN";

// A reopen may only move back to one of the three stages that own an artefact
// an audit finding can ask to amend.
const REOPENABLE = Object.freeze(["intent", "scope", "plan"]);

// The stages in order, with the post-merge terminal state last, so a target can
// be judged earlier or later than the current stage by a plain index compare.
const ORDER = Object.freeze([...STAGES, "done"]);

/** Index of a stage in lifecycle order, or -1 when the stage is unknown. */
function stageIndex(stage) {
  return ORDER.indexOf(stage);
}

/** The shape a refused reopen returns. */
function refuse(error) {
  return { ok: false, rule: R_REOPEN, error };
}

/**
 * Build the `reopen` event that moves `state` back to `finding.target`.
 *
 * `finding` names at least a `target` (the stage to reopen), a `relPath` (the
 * artefact that must be amended) and a `summary` (the finding itself). On a
 * valid finding and a target that is earlier than the current stage, this
 * returns the event object itself for the caller to append:
 *
 *   { type: "reopen",
 *     data: { from, to, finding },
 *     decision: { kind: "deterministic", rule: "R-REOPEN" } }
 *
 * Otherwise it returns `{ ok: false, rule: "R-REOPEN", error }` and leaves the
 * state to the caller.
 */
export function reopen(state, finding) {
  const from = state?.stage;
  if (stageIndex(from) < 0) {
    return refuse(`current stage ${JSON.stringify(from)} is not a lifecycle stage`);
  }
  if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
    return refuse("finding must be an object naming a target, a relPath and a summary");
  }

  const { target, relPath, summary } = finding;
  if (typeof target !== "string" || !REOPENABLE.includes(target)) {
    return refuse(`finding.target must be one of ${REOPENABLE.join(", ")}`);
  }
  if (typeof relPath !== "string" || relPath.trim() === "") {
    return refuse("finding.relPath must be a non-empty string");
  }
  if (typeof summary !== "string" || summary.trim() === "") {
    return refuse("finding.summary must be a non-empty string");
  }
  if (stageIndex(target) >= stageIndex(from)) {
    return refuse(`finding.target ${target} is not earlier than the current stage ${from}`);
  }

  return {
    type: "reopen",
    data: { from, to: target, finding },
    decision: { kind: "deterministic", rule: R_REOPEN },
  };
}

/**
 * Decide whether the reopened stage has completed again.
 *
 * Inputs: `cwd` (a repository), `base` (the ref the pipeline integrates into),
 * `relPath` (the artefact the finding named) and `previousAnchor` (the anchor
 * the artefact carried before the reopen, at least `{ commit }`).
 *
 * The stage completes only when the artefact anchors at `base` on a commit that
 * differs from `previousAnchor.commit` and descends from it - that is, the
 * amendment is newer on the base line. Returns `{ ok: true, anchor }` with the
 * resolved `{ path, commit, blob }`, or `{ ok: false, reason }` when the
 * artefact is still anchored at the old commit (for example because the change
 * lives only on an unmerged branch), is absent from `base`, or could not be
 * checked.
 */
export function reopenedStageComplete({ cwd, base, relPath, previousAnchor } = {}) {
  if (typeof cwd !== "string" || cwd.trim() === "") {
    return { ok: false, reason: "cwd must be a non-empty string" };
  }
  if (typeof base !== "string" || base.trim() === "") {
    return { ok: false, reason: "base must be a non-empty string" };
  }
  if (typeof relPath !== "string" || relPath.trim() === "") {
    return { ok: false, reason: "relPath must be a non-empty string" };
  }
  const previousCommit = previousAnchor?.commit;
  if (typeof previousCommit !== "string" || previousCommit.trim() === "") {
    return { ok: false, reason: "previousAnchor.commit must be a non-empty string" };
  }

  const anchored = anchorAt(cwd, base, relPath);
  if (!anchored.ok) {
    return { ok: false, reason: anchored.error };
  }
  if (anchored.commit === previousCommit) {
    return {
      ok: false,
      reason: `the artefact is still anchored at ${previousCommit}; the amendment is not on ${base}`,
    };
  }

  let descends;
  try {
    descends = isAncestor(cwd, previousCommit, anchored.commit);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (!descends) {
    return {
      ok: false,
      reason: `new anchor ${anchored.commit} does not descend from ${previousCommit}`,
    };
  }

  return { ok: true, anchor: anchored };
}
