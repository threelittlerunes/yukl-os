#!/usr/bin/env node
// A scripted fake of the GitHub CLI for the VCS adapter tests.
//
// It never talks to GitHub. Every invocation appends its own argv (the
// arguments after the script path) as one JSON array on a line to the file
// named by FAKE_GH_LOG, so a test can assert exactly which commands ran and
// with which flags. The reply is looked up in the JSON file named by
// FAKE_GH_SCENARIO under the key "<verb> <subcommand>" (for example
// "pr checks"), which maps to { exitCode?, stdout?, stderr? }. An unknown
// command exits 2 with a diagnostic on stderr, which keeps a mis-wired test
// loud rather than silently green.

import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);

const logPath = process.env.FAKE_GH_LOG;
if (logPath) appendFileSync(logPath, `${JSON.stringify(args)}\n`);

let scenario = {};
const scenarioPath = process.env.FAKE_GH_SCENARIO;
if (scenarioPath) {
  try {
    scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
  } catch {
    scenario = {};
  }
}

const key = `${args[0] ?? ""} ${args[1] ?? ""}`;
const reply = scenario[key];

if (!reply) {
  process.stderr.write(`fake-gh: no scenario for "${key}"\n`);
  process.exitCode = 2;
} else {
  if (reply.stdout) process.stdout.write(String(reply.stdout));
  if (reply.stderr) process.stderr.write(String(reply.stderr));
  process.exitCode = typeof reply.exitCode === "number" ? reply.exitCode : 0;
}
