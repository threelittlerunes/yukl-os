import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson, readYaml } from "../scripts/lib/harness.js";
import {
  validateFlowConfig,
  validateIntent,
  validateGithubStandards,
  validateOrcaYaml,
  validateShippedFiles,
} from "../scripts/validate-config.js";

test("flow.config.json parses and satisfies the pipeline schema", () => {
  const raw = readJson("flow.config.json");
  assert.equal(typeof raw.artifactsDir, "string");
  assert.ok(raw.pipeline.length > 0, "pipeline must not be empty");

  const { errors } = validateFlowConfig();
  assert.deepEqual(errors, []);
});

test("flow.config.json drafter writes the standardised contract path", () => {
  const raw = readJson("flow.config.json");
  const drafter = raw.pipeline.find((s) => s.id === "expert-power-drafter");
  assert.ok(drafter, "expert-power-drafter stage is required");
  assert.equal(drafter.writes, ".orchestration/contracts/<task_id>.json");
});

test("flow.config.json auditor gate is explicitly declared (IC-5)", () => {
  const raw = readJson("flow.config.json");
  const auditor = raw.pipeline.find((s) => s.id === "coercive-power-auditor");
  assert.ok(auditor, "coercive-power-auditor stage is required");
  assert.equal(typeof auditor.gate, "boolean");
});

test(".yukl-intent.yml parses and contains no placeholder text (IC-10)", () => {
  const doc = readYaml(".yukl-intent.yml");
  assert.ok(doc.intent, "intent block is required");
  assert.ok(doc.rational_persuasion.empirical_proof.length > 0);

  const { errors } = validateIntent();
  assert.deepEqual(errors, []);
});

test("orca.yaml is structurally cross-checked against flow.config.json and the contract schema", () => {
  const { errors } = validateOrcaYaml();
  assert.deepEqual(errors, []);
});

test("GitHub community-health files are present", () => {
  const { errors } = validateGithubStandards();
  assert.deepEqual(errors, []);
});

test("shipped files contain no template placeholders (V-4)", () => {
  const { errors } = validateShippedFiles();
  assert.deepEqual(errors, []);
});
