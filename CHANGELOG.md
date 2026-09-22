# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- Scheduled artifact purge implementing the retention policy in
  `.orchestration/artifacts/README.md`.
- GitHub Action implementing the Phase 5 feedback loop (see `docs/SDLC_PLAN.md`).

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
