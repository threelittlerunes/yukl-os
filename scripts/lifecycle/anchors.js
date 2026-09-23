#!/usr/bin/env node
// Committed-artefact anchors.
//
// A contract only means something if it points at a commit and blob that
// genuinely exist on the ref being gated. This module resolves that anchor with
// plumbing commands (`git log`, `git rev-parse`, `git merge-base`) invoked with
// an explicit argument array, never a shell string, so a crafted path cannot
// smuggle in extra flags or a second command.

import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

/** Run git in `cwd` with an argument array. Returns { ok, stdout|error }. */
function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    return { ok: false, error: stderr || `git ${args.join(" ")} exited with ${result.status}` };
  }
  return { ok: true, stdout: result.stdout ?? "" };
}

/**
 * Normalise a repository-relative path to forward slashes and refuse the two
 * shapes that could escape the repository: an absolute path, or any `..`
 * segment. Returns { ok: true, path } or { ok: false, error }.
 */
function normaliseRelPath(relPath) {
  if (typeof relPath !== "string" || relPath.trim() === "") {
    return { ok: false, error: "relPath must be a non-empty string" };
  }
  const slashed = relPath.replace(/\\/g, "/");
  if (isAbsolute(relPath) || slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) {
    return { ok: false, error: `absolute paths are refused: ${relPath}` };
  }
  const segments = slashed.split("/");
  if (segments.includes("..")) {
    return { ok: false, error: `paths containing ".." are refused: ${relPath}` };
  }
  const cleaned = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  if (cleaned === "") {
    return { ok: false, error: `path does not name a file: ${relPath}` };
  }
  return { ok: true, path: cleaned };
}

/**
 * Resolve the last commit on `ref` that touched `relPath`, and the blob id of
 * that path within that commit.
 * Returns { ok: true, path, commit, blob } or { ok: false, error }. The failure
 * shape is used for a path that is absent from `ref`'s history, which covers a
 * file that exists only in the working tree and one committed only on an
 * unreachable branch.
 */
export function anchorAt(cwd, ref, relPath) {
  const normalised = normaliseRelPath(relPath);
  if (!normalised.ok) return { ok: false, error: normalised.error };

  const log = runGit(cwd, ["log", "-1", "--format=%H", ref, "--", normalised.path]);
  if (!log.ok) return { ok: false, error: log.error };
  const commit = log.stdout.trim();
  if (commit === "") {
    return { ok: false, error: `no commit on ${ref} touches ${normalised.path}` };
  }

  const rev = runGit(cwd, ["rev-parse", `${commit}:${normalised.path}`]);
  if (!rev.ok) return { ok: false, error: rev.error };
  const blob = rev.stdout.trim();
  if (blob === "") {
    return { ok: false, error: `cannot resolve ${normalised.path} at ${commit}` };
  }

  return { ok: true, path: normalised.path, commit, blob };
}

/**
 * True when `commit` is reachable from `ref`, i.e. an ancestor of it. Exit 0 is
 * true, exit 1 is false; any other exit - an unknown revision, a cwd that is
 * not a repository - is an error and is surfaced by throwing.
 */
export function isAncestor(cwd, commit, ref) {
  if (typeof commit !== "string" || commit.trim() === "") {
    throw new Error("commit must be a non-empty string");
  }
  if (typeof ref !== "string" || ref.trim() === "") {
    throw new Error("ref must be a non-empty string");
  }
  const result = spawnSync("git", ["merge-base", "--is-ancestor", commit, ref], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`git merge-base --is-ancestor failed: ${result.error.message}`);
  }
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const stderr = (result.stderr || "").trim();
  throw new Error(
    stderr || `git merge-base --is-ancestor ${commit} ${ref} exited with ${result.status}`,
  );
}
