# Yukl-OS: SDLC Implementation Plan

## Phase 1: Position Power & The "Vanilla" Sandbox
**Situational Control (Native Sandboxing):** Control the agent by controlling its environment. Use native **Git worktrees** to isolate parallel agents. This lets multiple agents operate concurrently across numbered terminal tabs without overwriting each other's files. It provides true filesystem isolation for the SWE while remaining a "surprisingly vanilla" and frictionless setup for the vibecoder. There is one VCS in this repository: Git.

**Legitimate Power (The Orchestrator):** Configure a minimal, strict root `CLAUDE.md`. The orchestrator uses this file to enforce system boundaries and delegate work, preventing sub-agents from altering global project rules.

## Phase 2: Personal Power & "Plan-First" Delegation
**Expert Power (Specialized Harnesses):** Fanning out tasks to specialists is key. Define one agent strictly for planning, another for feature implementation, and perhaps a dedicated agent for refactoring or cleaning up code.

**The Consultation Tactic (Design Contracts):** Before a coding agent executes, it must generate a plan and define empirical acceptance criteria (for example a specific test that must pass). This guarantees the agent is aligned with the orchestrator's intent before burning API tokens.

## Phase 3: Autonomous Orchestration (The Loops)
**"Loops Do The Work":** Implement continuous scheduling mechanics (like a `/loop` command). Instead of manually triggering agents, configure them to run via cron jobs overnight to autonomously babysit PRs, auto-rebase branches, or repeatedly attempt to fix flaky CI tests.

**Parallel Execution:** Run these loops across 5 to 10 parallel local sessions, allowing the agentic harness to act as a persistent operating layer rather than just a chat tool.

## Phase 4: Coercive Guardrails & Rational Persuasion
**Rational Persuasion (Empirical Verification):** Agents cannot just claim a task is complete. They must "persuade" the orchestrator by passing the empirical acceptance check defined in Phase 2 (for example submitting a passing AST test log or curl command output). In this repository the contract lives at `.orchestration/contracts/<task_id>.json` and is validated by `npm run test`.

**Coercive Power (Kill-Switches):** Implement lightweight middleware that monitors API budgets and token usage. If an agent loops endlessly or breaches its financial quota, the system exercises coercive power to instantaneously terminate the session.

## Phase 5: Institutional Memory & Self-Improvement (Future Work)

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

1. **Runtime dependency:** Prerequisite 2 (the contract-and-audit loop in active use) cannot be met until the render/verify runtime exists, because nothing has executed the pipeline end to end before it. Phase 5 is blocked on that runtime.
2. **Human decisions:** Prerequisites 3 (a scoped GitHub token / App) and 4 (a written review policy for automated edits to `CLAUDE.md` and `AGENTS.md`) are decisions for the repository maintainer, not for the harness.
3. **Signal definition:** Undecided which PR events count as a correction: review comments, commits that apply a suggested change, or reviews that request changes.
4. **Digestion:** Summarising corrections requires an LLM call from GitHub Actions, which means an API secret, a cost budget, and a choice of model. All undecided.
5. **Budget:** `CLAUDE.md` is capped at 60 lines and rule files carry instruction budgets (tests/rules.test.js). Automated proposals must pass `npm run test` or be rejected; they must never be truncated silently.
6. **Scope:** Proposals must target `CLAUDE.md` and `AGENTS.md` together, because tests/agents.test.js requires the two files to remain identical.

**Empirical acceptance criterion for starting Phase 5 planning:** `yukl verify` has passed on at least one merged PR in a repository using the harness.
