#!/usr/bin/env node
// AF-4: Instruction-budget enforcement CLI.
//
// The central thesis of the Yukl Power Harness is that a system prompt which
// exceeds roughly 150 concurrent instructions suffers a measurable collapse in
// instruction adherence. That claim is only meaningful if it is measured, so
// this CLI counts the directives injected into an agent's context by
// CLAUDE.md and every path-scoped rule file, and fails the build when a file
// exceeds its budget. The counting logic itself is repo-only and lives in
// scripts/repo-checks.js; this entry point is only wired into this repo's
// `npm run test`.

import { BUDGETS, measure } from "./repo-checks.js";

export { BUDGETS, countInstructions, measure } from "./repo-checks.js";

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
