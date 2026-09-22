#!/usr/bin/env node
// AF-4: Instruction-budget enforcement.
//
// The central thesis of the Yukl Power Harness is that a system prompt which
// exceeds roughly 150 concurrent instructions suffers a measurable collapse in
// instruction adherence. That claim is only meaningful if it is measured, so
// this script counts the directives injected into an agent's context by
// CLAUDE.md and every path-scoped rule file, and fails the build when a file
// exceeds its budget.

import { listRuleFiles, readText, splitFrontmatter } from "./lib/harness.js";

/**
 * Per-file budgets. `maxInstructions` caps the directive count; `maxLines`
 * (optional) caps raw line count - the root constitution is capped at 60 lines
 * by YUKL_ARCHITECTURE.md section 2.4.
 */
export const BUDGETS = {
  "CLAUDE.md": { maxLines: 60, maxInstructions: 40 },
  __total__: { maxInstructions: 150 },
  __default__: { maxInstructions: 30 },
};

/**
 * Count instructions (directives) in a markdown document.
 *
 * An instruction is a sentence-sized directive. Headings, blank lines, fenced
 * code blocks and HTML/YAML comments are ignored. List markers are stripped
 * before sentence splitting, so a one-line bullet is exactly one instruction
 * and a bullet holding three sentences is three.
 */
export function countInstructions(text) {
  const { body } = splitFrontmatter(text);
  let count = 0;
  let inFence = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line === "") continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("<!--") || line.startsWith("//")) continue;

    const content = line.replace(/^(?:[-*+]|\d+\.)\s+/, "").trim();
    if (content === "") continue;

    const sentences = content
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    count += Math.max(1, sentences.length);
  }

  return count;
}

/** Measure every budgeted file and return the rows plus any violations. */
export function measure() {
  const files = ["CLAUDE.md", ...listRuleFiles()];
  const rows = [];
  const violations = [];
  let total = 0;

  for (const file of files) {
    const text = readText(file);
    const instructions = countInstructions(text);
    const lines = text.split(/\r?\n/).length;
    const budget = BUDGETS[file] ?? BUDGETS.__default__;

    total += instructions;
    rows.push({ file, lines, instructions, budget });

    if (budget.maxLines !== undefined && lines > budget.maxLines) {
      violations.push(`${file}: ${lines} lines exceeds the ${budget.maxLines}-line cap`);
    }
    if (instructions > budget.maxInstructions) {
      violations.push(
        `${file}: ${instructions} instructions exceeds the ${budget.maxInstructions}-instruction budget`,
      );
    }
  }

  if (total > BUDGETS.__total__.maxInstructions) {
    violations.push(
      `Total: ${total} instructions exceeds the ${BUDGETS.__total__.maxInstructions}-instruction system budget`,
    );
  }

  return { rows, total, violations };
}

function main() {
  const { rows, total, violations } = measure();

  const header = ["file", "lines", "instr", "budget"];
  const widths = [Math.max(header[0].length, ...rows.map((r) => r.file.length)), 7, 7, 7];
  const pad = (v, w) => String(v).padEnd(w);

  console.log("Instruction budget report");
  console.log("=========================");
  console.log(
    `${pad(header[0], widths[0])} ${pad(header[1], widths[1])} ${pad(header[2], widths[2])} ${pad(header[3], widths[3])}`,
  );
  for (const row of rows) {
    console.log(
      `${pad(row.file, widths[0])} ${pad(row.lines, widths[1])} ${pad(row.instructions, widths[2])} ${pad(row.budget.maxInstructions, widths[3])}`,
    );
  }
  console.log(
    `${pad("TOTAL", widths[0])} ${pad("", widths[1])} ${pad(total, widths[2])} ${pad(BUDGETS.__total__.maxInstructions, widths[3])}`,
  );

  if (violations.length > 0) {
    console.error("\nInstruction budget FAILED:");
    for (const v of violations) console.error(`  - ${v}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nInstruction budget OK.");
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("count-instructions.js")
) {
  main();
}
