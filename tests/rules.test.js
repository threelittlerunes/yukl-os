import { test } from "node:test";
import assert from "node:assert/strict";
import { readText, readYaml, splitFrontmatter, listRuleFiles } from "../scripts/lib/harness.js";
import { measure, countInstructions } from "../scripts/count-instructions.js";
import {
  validateRules,
  validateConsistency,
  validateOrcaYaml,
} from "../scripts/validate-config.js";

test("countInstructions ignores headings, blanks and fenced code", () => {
  const sample = [
    "# Heading",
    "",
    "- One directive.",
    "- Two directives. This is the second.",
    "```",
    "not an instruction",
    "```",
    "<!-- comment -->",
    "A closing prose line.",
  ].join("\n");
  assert.equal(countInstructions(sample), 4);
});

test("every rule file stays inside its instruction budget (AF-4)", () => {
  const { violations } = measure();
  assert.deepEqual(violations, []);
});

test("CLAUDE.md stays under the 60-line root cap", () => {
  const lines = readText("CLAUDE.md").split(/\r?\n/).length;
  assert.ok(lines <= 60, `CLAUDE.md is ${lines} lines; cap is 60`);
});

test("all path-scoped rules declare frontmatter paths (IC-8)", () => {
  assert.ok(listRuleFiles().length >= 5);
  const { errors } = validateRules();
  assert.deepEqual(errors, []);
});

test("no document references Jujutsu, CONTRACT.json or Ecological Power (AF-5/6/7)", () => {
  const { errors } = validateConsistency();
  assert.deepEqual(errors, []);
});

test("drafter-ui.md frontmatter scopes src/ui/** (IC-1)", () => {
  const { frontmatter } = splitFrontmatter(readText(".claude/rules/drafter-ui.md"));
  assert.deepEqual(frontmatter.paths, ["src/ui/**"]);
});

test("auditor.md is forbidden from a src/** write scope (AF-10)", () => {
  const { frontmatter } = splitFrontmatter(readText(".claude/rules/auditor.md"));
  assert.deepEqual(frontmatter.paths, [".orchestration/contracts/*.json"]);
});

test("CLAUDE.md section 2 routes every rule file (V-1)", () => {
  const text = readText("CLAUDE.md");
  for (const file of listRuleFiles()) {
    assert.ok(text.includes(file), `CLAUDE.md does not route ${file}`);
  }
});

test("orca.yaml lists every rule file under an agent (V-2)", () => {
  const listed = new Set();
  for (const agent of Object.values(readYaml("orca.yaml").agents ?? {})) {
    for (const rule of agent.rules ?? []) listed.add(rule);
  }
  for (const file of listRuleFiles()) {
    assert.ok(listed.has(file), `orca.yaml does not list ${file}`);
  }
  const { errors } = validateOrcaYaml();
  assert.deepEqual(errors, []);
});
