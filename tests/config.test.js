import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson, readYaml } from "../scripts/lib/harness.js";
import { validateFlowConfig, validateIntent } from "../scripts/validate-config.js";
import {
  ALLOWED_AGENTS,
  validateGithubStandards,
  validateOrcaYaml,
  validateShippedFiles,
} from "../scripts/repo-checks.js";

test("flow.config.json parses and satisfies the pipeline schema", () => {
  const raw = readJson("flow.config.json");
  assert.equal(typeof raw.artifactsDir, "string");
  assert.ok(raw.pipeline.length > 0, "pipeline must not be empty");

  const { errors } = validateFlowConfig();
  assert.deepEqual(errors, []);
});

test("orca.yaml, flow.config.json and yukl.config.json route the drafting runtime to omp and validate (task routing-omp)", () => {
  const orca = readYaml("orca.yaml");
  assert.equal(orca.agents.drafter.agent, "omp", "orca.yaml must route the drafter to omp");

  const flow = readJson("flow.config.json");
  const drafter = flow.pipeline.find((s) => s.id === "expert-power-drafter");
  assert.ok(drafter, "expert-power-drafter stage is required");
  assert.equal(drafter.agent, "omp", "the drafter stage must route to omp");

  // orca.yaml and flow.config.json describe the pipeline, but `yukl run`
  // dispatches a stage from yukl.config.json (lifecycle.runtimes), so the two
  // above can both say omp while a live run still starts opencode.
  const yukl = readJson("yukl.config.json");
  const runtimes = yukl.lifecycle?.runtimes ?? {};
  assert.equal(
    runtimes.implement?.agent,
    "omp",
    "yukl.config.json must route the implement stage to omp",
  );
  assert.equal(
    runtimes.audit?.agent,
    "antigravity",
    "yukl.config.json must leave the audit stage on antigravity",
  );
  assert.equal(
    runtimes.review?.agent,
    "antigravity",
    "yukl.config.json must leave the review stage on antigravity",
  );

  assert.ok(ALLOWED_AGENTS.includes("omp"), "omp must be an allowed agent");

  assert.deepEqual(validateOrcaYaml().errors, []);
  assert.deepEqual(validateFlowConfig().errors, []);
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
