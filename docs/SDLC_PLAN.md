<!-- yukl:doc-status -->
# Yukl-OS: SDLC Implementation Plan

## Phase 1: Position Power & The "Vanilla" Sandbox
<!-- status: background -->

This phase has two halves: the sandbox, which the runner provides, and the root
constitution, which the build checks.

### Situational Control (Native Sandboxing)
<!-- status: background -->
Control the agent by controlling its environment. Use native **Git worktrees** to isolate parallel agents. This lets multiple agents operate concurrently across numbered terminal tabs without overwriting each other's files. It provides true filesystem isolation for the SWE while remaining a "surprisingly vanilla" and frictionless setup for the vibecoder. Git is required; Jujutsu is supported when colocated. Worktree isolation is provided by the runner for hand-started agents, and by `yukl schedule`, which gives each task its own worktree under `.orchestration/worktrees/<task_id>` and has a test for it (`tests/command-schedule.test.js`).

### Legitimate Power (The Orchestrator)
<!-- status: implemented tests=tests/rules.test.js#CLAUDE.md stays under the 60-line root cap -->
Configure a minimal, strict root `CLAUDE.md`. The orchestrator uses this file to enforce system boundaries and delegate work, preventing sub-agents from altering global project rules. The root cap is enforced by `tests/rules.test.js`.

## Phase 2: Personal Power & "Plan-First" Delegation
<!-- status: background -->
**Expert Power (Specialized Harnesses):** Fanning out tasks to specialists is key. Define one agent strictly for planning, another for feature implementation, and perhaps a dedicated agent for refactoring or cleaning up code.

**The Consultation Tactic (Design Contracts):** Before a coding agent executes, it must generate a plan and define empirical acceptance criteria (for example a specific test that must pass). This guarantees the agent is aligned with the orchestrator's intent before burning API tokens. In the v2 runtime this is realised by the per-task intent and the proof contract described in section 4 of `docs/YUKL_ARCHITECTURE.md`; the separate planning agent described above is not built.

## Phase 3: Autonomous Orchestration (The Loops)
<!-- status: planned -->
**"Loops Do The Work":** Implement continuous scheduling mechanics (like a `/loop` command). Instead of manually triggering agents, configure them to run via cron jobs overnight to autonomously babysit PRs, auto-rebase branches, or repeatedly attempt to fix flaky CI tests. Built: the loop mechanism itself - `yukl run --unattended` and the scheduler described below. Still not built: the trigger layer and the PR-babysitting loops.

**Parallel Execution:** Run these loops across 5 to 10 parallel local sessions, allowing the agentic harness to act as a persistent operating layer rather than just a chat tool. Built: `yukl run --unattended` keeps driving a task until it is terminal, needs a human, escalates or breaches a run limit, and `yukl schedule` runs tasks whose scopes cannot overlap in parallel worktrees while serialising the rest. Still not built: cron or overnight triggering and the PR-babysitting loops. Sections 4.7 and 4.13 of `docs/YUKL_ARCHITECTURE.md` document both commands.

## Phase 4: Coercive Guardrails & Rational Persuasion
<!-- status: background -->
This phase pairs a built enforcement with a planned one.

### Rational Persuasion (Empirical Verification)
<!-- status: implemented tests=tests/yukl.test.js#verify fails when an allowlisted command actually exits non-zero -->
Agents cannot just claim a task is complete. They must "persuade" the orchestrator by passing the empirical acceptance check defined in Phase 2 (for example submitting a passing AST test log or curl command output). In this repository the contract lives at `.orchestration/contracts/<task_id>.json` and is executed by `yukl verify`, which the build and CI run.

### Coercive Power (Kill-Switches)
<!-- status: planned -->
Implement lightweight middleware that monitors API budgets and token usage. If an agent loops endlessly or breaches its financial quota, the system exercises coercive power to instantaneously terminate the session. Not built as described: there is no token or cost meter, and `maxTokensPerRun` has been removed rather than enforced, because no adapter can measure tokens. What is enforced are the two run limits - `maxWallMinutesPerRun` and `maxAgentStartsPerRun` stop a run that breaches them by appending an `R-RUN-LIMIT` enforcement event - and that stop ends the run, it does not kill the agent process. Section 4.7 of `docs/YUKL_ARCHITECTURE.md` has the details.

## Phase 5: Institutional Memory & Self-Improvement (Future Work)
<!-- status: planned -->

> **Status: FUTURE WORK - not implemented.** This phase describes a target state, not current behaviour. Do not rely on it.

**The PR Feedback Loop (planned):** When human reviewers correct an agent's code in a GitHub Pull Request, a GitHub Action would digest the feedback and propose a durable rule change.

**Dynamic CLAUDE.md Updates (planned):** That action would translate the human correction into a durable rule and open a pull request against `CLAUDE.md`. Over time this would transform individual mistakes into persistent organizational memory.

**Prerequisites before this phase can start:**

1. CI is green on the default branch (`npm run build`, `npm run test`).
2. The contract-and-audit loop (Phases 1-4) is in active use on at least one repository.
3. A scoped GitHub token / App with permission to open pull requests is provisioned.
4. A written review policy defines who may approve automated changes to `CLAUDE.md` and the rule files.
5. A documented rollback path (Git revert) exists before any automated rule edit lands.
6. The instruction-budget check passes on the proposed edit, so automated growth cannot silently breach the 150-instruction limit.

### Open scoping questions (must be answered before planning)
<!-- status: planned -->

1. **Runtime dependency:** The render/verify runtime now exists - `yukl render`, `yukl run` (attended and unattended; section 4.7 of `docs/YUKL_ARCHITECTURE.md`) and `yukl verify` drive the stage machine end to end, and this repository's CI already runs `yukl verify --base` on every pull request (`.github/workflows/ci.yml`) against the contracts merged in `.orchestration/contracts/`. Prerequisite 2 is therefore no longer blocked on missing tooling; what remains is the maintainer's call on whether that usage satisfies "in active use on at least one repository".
2. **Human decisions:** Prerequisites 3 (a scoped GitHub token / App) and 4 (a written review policy for automated edits to `CLAUDE.md` and `AGENTS.md`) are decisions for the repository maintainer, not for the harness.
3. **Signal definition:** Undecided which PR events count as a correction: review comments, commits that apply a suggested change, or reviews that request changes.
4. **Digestion:** Summarising corrections requires an LLM call from GitHub Actions, which means an API secret, a cost budget, and a choice of model. All undecided.
5. **Budget:** `CLAUDE.md` is capped at 60 lines and rule files carry instruction budgets (tests/rules.test.js). Automated proposals must pass `npm run test` or be rejected; they must never be truncated silently.
6. **Scope:** Proposals must target `CLAUDE.md` and `AGENTS.md` together, because tests/agents.test.js requires the two files to remain identical.

**Empirical acceptance criterion for starting Phase 5 planning:** `yukl verify` has passed on at least one merged PR in a repository using the harness.
