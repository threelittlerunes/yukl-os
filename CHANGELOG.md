# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Agent-agnostic runtime: `yukl render` and `yukl verify` (`scripts/yukl.js`)
  plus a `verify-contract` CI job for committed Rational Persuasion contracts,
  designed to be the merge gate and blocking merges once it is configured as a
  required status check on the default branch (task B).
- Committed contract evidence: `.orchestration/contracts/*.json` is now
  tracked in version control (tasks A, B and C).
- Phase 5 scoping note in `docs/SDLC_PLAN.md` (task C).
- `AGENTS.md` mirroring `CLAUDE.md` with a byte-identity sync test (task A).

### Changed
- `yukl render` and `yukl verify` now resolve the target repository from
  `process.cwd()` or an explicit `--cwd` flag instead of the package directory,
  so the core runs inside any repository; the `render` reads-fallback looks for
  `flow.config.json` next to the given config (task F).
- Repo-only governance checks (community files, rule routing, CLAUDE.md/AGENTS.md
  parity, instruction budgets) moved out of the installable core into
  `scripts/repo-checks.js`, which only this repo's `npm run build` and
  `npm run test` call (task F).
- `{out}`, `{reads}` and `<task_id>` are substituted by `yukl render`; no agent
  runtime is assumed (task B).
- `docs/YUKL_ARCHITECTURE.md` section 3.4 no longer claims an Orca flow engine
  will enforce the consensus gate; the rule is documented as review policy on
  top of the `verify-contract` and `validate` CI merge gate (task D).
- `js-yaml` moved to `dependencies`: the verify runtime parses
  `.yukl-intent.yml` (task B).
- `package.json` marked private at version 2.1.0 (task A).
- Dropped the AF-6 "no Jujutsu" invariant: Jujutsu is supported when colocated
  with Git, and `yukl verify` refuses a Jujutsu-only repo (`.jj` without
  `.git`, file or directory) with a message naming `jj git colocation enable`,
  while the dirty-tree warning reminds colocated users to run `jj new` so the
  change becomes HEAD (task E).

### Fixed
- `yukl render` resolves `reads` ids against `flow.config.json` when the given
  `--config` does not define the stage, so cross-config renders such as
  `review-pass-a --config review.config.json` no longer exit 2 (task D).
- `yukl verify` rejects any `expected_exit_code` other than 0, closing a gate
  bypass where a failing test could be claimed as passing proof (task B2).
- Docs-only pull requests pass `yukl verify --base` without a contract file;
  the contract requirement applies to code changes (task B2).
- Unsafe `npx` invocation guidance replaced with `npm run verify -- --base
  origin/main`; the gate is not a sandbox and the docs now say so (task B2).
- `yukl verify` times out hung proof commands after 600000 ms by default
  (overridable via `--timeout-ms`), so a hanging command can no longer hang the
  gate (task B3).
- `yukl verify --base` now warns on stderr when the working tree carries
  uncommitted or untracked changes, since the preview checks committed state
  only (base...HEAD) (task B3).

### Planned
- Scheduled artifact purge implementing the retention policy in
  `.orchestration/artifacts/README.md`.
- GitHub Action implementing the Phase 5 feedback loop (see `docs/SDLC_PLAN.md`).
- Phase 3 autonomous loop scheduling.

## [2.1.0] - 2026-09-22

Post-audit hardening: dual-pipeline review, structural cross-validation, and
deterministic-first governance principles.

### Added
- Dual-pipeline A/B review mode (`review.config.json`) with independent passes
  and consensus extraction gate (`b7e6d32`).
- Full structural cross-validation of `orca.yaml` against `flow.config.json`
  and the contract schema (`16609de`).
- Independent QA verdict prompt (`VERDICT_PROMPT.md`) (`19e5f18`).
- Deterministic-first validation principle in `CONTRIBUTING.md` (`67c1a0b`).
- Consensus-gating rule for P0/P1 findings in review docs (`6585c7f`).

### Changed
- Consistency test name narrowed to match its actual scan scope (`fc00b7d`).
- Biome config updated to ignore contract JSON; instruction count corrected in
  reaudit verdict (`7a368d0`).

### Fixed
- Full union remediation of A/B review findings V-1 through V-5 and C-1
  through C-13 (`13eaa52`, `48bea19`).

## [2.0.0] - 2026-09-22

Remediation of the independent architectural audit (`docs/AUDIT_REPORT.md`).

### Added
- Executable runtime: `package.json` with `build`, `test` and `format` scripts,
  Biome as a formatter/linter, and a `node --test` suite validating the harness
  configuration (`AF-1`).
- Instruction-budget enforcement: `scripts/count-instructions.js`, wired into
  `npm test`, fails the build when any rule file exceeds its budget (`AF-4`).
- Path-scoped UI rule `.claude/rules/drafter-ui.md` (`AF-2`, `IC-1`).
- `.orchestration/contracts/`, `.orchestration/locks/` and
  `.orchestration/artifacts/` directories with `.gitkeep`.
- Observability contract: `.orchestration/artifacts/README.md` defining the
  NDJSON log format, trace-ID convention and retention policy (`AF-9`).
- MIT `LICENSE` (`AF-3`).
- GitHub community-health files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, `CHANGELOG.md`, `.gitignore`, issue and pull-request templates,
  and a CI workflow.
- README status badges.

### Changed
- Standardised on **Git worktrees**; all Jujutsu/`jj` references removed
  (`AF-6`, `IC-2`, `IC-7`).
- Standardised the contract filename to
  `.orchestration/contracts/<task_id>.json` everywhere (`AF-7`, `IC-3`).
- Distinguish French & Raven's bases of power from Yukl's influence tactics;
  removed the invented "Ecological Power" term and corrected the Referent Power
  misattribution (`AF-5`).
- `auditor.md` path scope is now read-only: source code is no longer in scope
  (`AF-10`, `IC-4`).
- `orca.yaml` now declares pipeline, agent, worktree and task configuration
  (`AF-11`, `IC-9`).
- Replaced placeholder text in `.yukl-intent.yml` with a real, validated intent
  (`IC-10`).
- Auditor pipeline stage now declares `gate: true`, matching the README's
  Consultation guarantee (`IC-5`).
- Independent plan auditor and contract auditor roles explicitly delineated
  (`IC-8`).

### Fixed
- Phantom file references and missing directories that made contract writes fail.

## [1.0.0] - 2026-08-01

### Added
- Initial Yukl Power Harness: `flow.config.json`, `CLAUDE.md`, path-scoped
  rules, and the `docs/` architecture and SDLC plan.
