#!/usr/bin/env node
// Validator plugin: the lifecycle run configuration.
//
// Loaded by scripts/validate-config.js from scripts/validators/*.js. The
// `lifecycle` block in yukl.config.json names the runtime adapter for each
// agent stage, the VCS adapter the integrate stage merges through and the
// directory holding the per-task event logs. `yukl run` reads the block back
// through `lifecycleViolations`, so the same checks guard both the repository
// build and a live run.
//
// The block is optional: a repository that never runs the engine may omit it.
// When it is present, every adapter name must be a valid command name with a
// matching file under scripts/adapters/, every agent must be a non-empty string
// and the state directory must resolve inside the repository root.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isCommandName } from "../yukl.js";

export const name = "lifecycle";

const ADAPTERS_SUBDIR = join("scripts", "adapters");
const CONFIG_FILE = "yukl.config.json";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The repository-relative adapter file a name must have under `root`. */
function adapterFile(root, adapterName) {
  return join(root, ADAPTERS_SUBDIR, `${adapterName}.js`);
}

/**
 * Check one `adapter` name: it must be shaped like a command name and a file
 * must exist for it under `root`. `label` names the field in a message.
 */
function checkAdapterName(errors, root, adapterName, label) {
  if (!isCommandName(adapterName)) {
    errors.push(`${label} must be a command name: lower-case letters and hyphens, e.g. "orca"`);
    return;
  }
  if (!existsSync(adapterFile(root, adapterName))) {
    errors.push(
      `${label} "${adapterName}" has no adapter file ${ADAPTERS_SUBDIR.replace(/\\/g, "/")}/${adapterName}.js`,
    );
  }
}

/**
 * Pure checker for a `lifecycle` block against `root`. Returns an array of
 * violation strings (empty array = valid). `root` is the repository the
 * adapter files and the state directory are resolved against, so a test can
 * validate a block against a temporary root.
 */
export function lifecycleViolations(block, root) {
  const errors = [];
  if (!isPlainObject(block)) {
    return ["lifecycle must be a mapping"];
  }

  if (!isPlainObject(block.runtimes) || Object.keys(block.runtimes).length === 0) {
    errors.push("lifecycle.runtimes must be a non-empty mapping of stage ids");
  } else {
    for (const [stage, entry] of Object.entries(block.runtimes)) {
      const at = `lifecycle.runtimes.${stage}`;
      if (!isPlainObject(entry)) {
        errors.push(`${at} must be a mapping with an adapter and an agent`);
        continue;
      }
      checkAdapterName(errors, root, entry.adapter, `${at}.adapter`);
      if (typeof entry.agent !== "string" || entry.agent.trim() === "") {
        errors.push(`${at}.agent must be a non-empty string`);
      }
    }
  }

  checkAdapterName(errors, root, block.vcs, "lifecycle.vcs");

  if (typeof block.stateDir !== "string" || block.stateDir.trim() === "") {
    errors.push("lifecycle.stateDir must be a non-empty string");
  } else {
    const rel = relative(root, resolve(root, block.stateDir));
    if (isAbsolute(rel) || rel.startsWith("..")) {
      errors.push(`lifecycle.stateDir "${block.stateDir}" must resolve inside the repository root`);
    }
  }

  return errors;
}

/**
 * Plugin seam: read yukl.config.json under `root` and check its lifecycle
 * block when one is present. A missing or unparsable config is reported; an
 * absent lifecycle block is fine.
 */
export function validate(root) {
  const path = join(root, CONFIG_FILE);
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { errors: [`${CONFIG_FILE} cannot be read: ${err.message}`] };
  }
  if (doc?.lifecycle === undefined) return { errors: [] };
  return { errors: lifecycleViolations(doc.lifecycle, root).map((e) => `${CONFIG_FILE}: ${e}`) };
}
