#!/usr/bin/env node
// A minimal fake `orca` for adapter tests.
//
// It appends its own argv to a JSON-lines log named by the FAKE_ORCA_LOG
// environment variable (one JSON array per invocation, so a test can count
// calls and read back every argument) and answers from the scenario named by
// FAKE_ORCA_SCENARIO. A scenario is a JSON object keyed by the orchestration
// verb ("worker-start", "worker-show", "worker-stop"); each value may carry
// `exitCode` (default 0), `json` (stringified to stdout), `stdout` (written
// verbatim, for testing unparseable replies), and `stderr`. An unknown verb or
// an absent scenario answers a successful empty envelope.

import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);

const logPath = process.env.FAKE_ORCA_LOG;
if (logPath) appendFileSync(logPath, `${JSON.stringify(argv)}\n`);

let scenario = {};
const scenarioPath = process.env.FAKE_ORCA_SCENARIO;
if (scenarioPath) {
  try {
    scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
  } catch {
    scenario = {};
  }
}

const verbAt = argv.indexOf("orchestration");
const verb = verbAt === -1 ? argv[0] : argv[verbAt + 1];
const reply = scenario[verb] ?? { json: { ok: true, result: {} } };

if (reply.stdout !== undefined) process.stdout.write(reply.stdout);
else if (reply.json !== undefined) process.stdout.write(JSON.stringify(reply.json));
if (reply.stderr !== undefined) process.stderr.write(reply.stderr);

process.exitCode = typeof reply.exitCode === "number" ? reply.exitCode : 0;
