# Legitimate Power: Repository Constitution

This repository is governed by the Yukl Power Harness. It maps French & Raven's bases of power and Yukl's influence tactics onto the Orca Agentic SDLC. Your cognitive instruction budget is limited; follow this progressive-disclosure routing.

## 1. Architectural Boundaries (Non-Negotiable)
- **Tandem Concurrency:** You operate in an isolated Git worktree. Before mutating shared dependencies (e.g., `npm install`), acquire an advisory lock in `.orchestration/locks/`.
- **Zero-Trust Execution:** You do not hold the Legitimate Power to merge your own code. Hand all implementations to the Auditor through a Rational Persuasion contract.

## 2. Progressive Disclosure (Information Power)
Do NOT guess conventions. Rely on path-scoped rules injected into your context:
- If modifying `src/api/**` -> adhere to `.claude/rules/drafter-api.md`.
- If modifying `src/ui/**` -> adhere to `.claude/rules/drafter-ui.md`.
- If auditing an implementation -> adhere to `.claude/rules/auditor.md`.
- If modifying `docs/SDLC_PLAN.md` -> adhere to `.claude/rules/plan-drafter.md`.
- If auditing a plan -> adhere to `.claude/rules/independent-auditor.md`.

## 3. Rational Persuasion (The Contract)
Before concluding a task, you MUST write your empirical proof to `.orchestration/contracts/<task_id>.json`.
Provide:
1. The terminal command used to verify the code (e.g., test runner, AST check).
2. The expected exit code (must be `0`).
3. The scope of files touched.

## 4. Commands
- Build: `npm run build`
- Test: `npm run test`
- Format: `npx @biomejs/biome format --write .`

Failure to adhere would trigger process termination and `git worktree remove`; this enforcement loop is planned, not yet implemented.
