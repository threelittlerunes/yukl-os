# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `yukl run <task_id> --unattended` keeps driving one task until it is terminal,
  needs a human, escalates or breaches a run limit, waiting for a running stage
  instead of stopping at the 64-step cap; an attended run keeps the step-capped
  loop it has always had. The two run limits in `yukl.policy.json` are now
  enforced: an elapsed `maxWallMinutesPerRun` stops the run before the next
  step, an exhausted `maxAgentStartsPerRun` refuses the agent start that would
  exceed it (so a run at its limit still waits for the agent it dispatched),
  and either breach appends an `enforcement` event carrying `R-RUN-LIMIT` and
  the breached limit to the task's log before the run exits 1 (v3-unattended).
- `yukl schedule <task_id>... [--base <ref>]` drives several tasks unattended:
  each runs `yukl run --unattended` in its own Git worktree under
  `.orchestration/worktrees/<task_id>`, tasks whose intents' `allowed_paths`
  cannot overlap share a wave and run in parallel, overlapping tasks are
  serialised into later waves, and a task whose intent cannot be read is
  treated as an unknown scope that overlaps everything (v3-unattended).
- `yukl lock <hold|status|release> <name> [--task <id>] [-- <command>]` and the
  advisory lock broker behind it (`scripts/lifecycle/locks.js`): a lock is one
  file at `.orchestration/locks/<name>.lock`, created exclusively so the create
  is the mutual exclusion, recording `{ name, pid, host, task, at }`; `hold`
  releases it however the command ends, and a lock whose recorded process is
  gone is reclaimed by the next acquirer while an unparseable lock is refused
  rather than reclaimed (v3-unattended).

### Changed
- Removed `maxTokensPerRun` everywhere (policy, validator, `run.js`, tests,
  docs): no adapter can measure tokens, so it must not exist as a setting and
  the policy schema now refuses any `budgets` key that is not a run limit. The
  committed `yukl.policy.json` ships the two run limits switched on:
  `maxWallMinutesPerRun: 120` and `maxAgentStartsPerRun: 12`. A `null` limit is
  still unset, and `--unattended` is still refused before any adapter starts
  while either limit is unset (v3-unattended).
- The unattended refusal message names run limits, not budgets, and
  `docs/YUKL_ARCHITECTURE.md` sections 4.2, 4.5 and 4.7 describe the enforced
  limits while new sections 4.13 and 4.14 document the scheduler and the lock
  broker (v3-unattended).
- `yukl init`: installs the harness into a target repository on a feature
  branch without overwriting anything it already has. It refuses (exit 1, no
  writes) outside a Git repo, on the default branch, on a detached HEAD, on a
  dirty working tree, and when no proof command is detectable and none is
  supplied with `--command <key>=<cmd>` (an empty allowlist would fail the
  config schema); in a colocated Jujutsu repo, where git HEAD is always
  detached, it refuses only while the working-copy commit is still the default
  branch's tip. It writes `yukl.config.json` (detected commands from
  `package.json` scripts and a line-based `pyproject.toml` scan for `ruff
  check` and `pytest`; undetected commands are `null`, never guessed), appends
  a `<!-- yukl:begin -->`/`<!-- yukl:end -->` section to existing `CLAUDE.md`,
  `AGENTS.md` and `GEMINI.md` files (missing files are skipped with a warning),
  creates `.orchestration/contracts/.gitkeep` and
  `.orchestration/intents/.gitkeep`, and installs a CI workflow at
  `.github/workflows/yukl.yml` that runs the repo's detected checks and gates
  the PR on `yukl verify --base origin/<base_ref>` (task H).
- `yukl init` detects subdirectory projects: `--project-dir <rel>` names
  them, and when the root has neither `package.json` nor `pyproject.toml`,
  directories one level below the root holding one of those files are
  auto-detected with a warning. Commands for a subdirectory project carry a
  `cd <dir> && ` prefix (e.g. `cd app && python -m ruff check`) because
  verify executes allowlisted commands from the repo root; the generated CI
  runs each check in its own subshell, so one command's `cd` cannot leak
  into the next line and break it (task H). The workflow is Linux-only, and
  the `cd`/`&&` form is equally valid in sh, cmd and PowerShell.
- The generated CI runs a **commit-pinned** yukl (`npm exec --package=github:threelittlerunes/yukl-os#<sha>`)
  taken from `--yukl-pin` or detected from the harness checkout, never a
  floating ref. Before writing, init verifies the pin is pushed to the
  yukl-os remote (local remote-tracking branches, then `git ls-remote`,
  failing closed offline; `YUKL_PIN_CHECK=off` opts out) and refuses with
  "pin `<sha>` is not pushed; push it or pass `--yukl-pin <pushed sha>`".
  On the bootstrap PR (no `yukl.config.json` at the base ref) the verify step
  prints "bootstrap: harness not installed at base; this PR is gated by human
  review" and exits 0, so the first PR is gated by human review alone and
  verify runs from the next PR on (task H).
- The generated verify step fails closed on a silent yukl: it captures the
  pinned yukl's output and exit status (`set +e`) and, when no line starts
  with `PASS` or `FAIL`, exits 1 with "yukl produced no output; the pinned
  version `<sha>` cannot run via the npm bin shim, so pin a release that
  includes task h". A yukl-os commit from before the task h bin-shim fix
  exits 0 with no output through npm's `.bin` shim, so pins must be at or
  after the task h merge; a failing verify still surfaces its output (task H).
- The generated CI installs Python dependencies: `pip install -e "<dir>[dev]"`
  when `pyproject.toml` declares a dev or test extra under
  `[project.optional-dependencies]`, otherwise `pip install <detected tools>`
  with a warning, so ruff and pytest actually exist in CI when the proof
  commands run (task H).
- `scripts/yukl.js` now decides whether it is the entry point by comparing
  the realpaths of `import.meta.url` and `process.argv[1]`, so `main()` runs
  through npm's `.bin` shim on Linux (symlink) and Windows (`.cmd` wrapper)
  alike; proven by a test that installs `npm pack` output into a temp folder
  and runs its `.bin/yukl` (task H).
- Agent-agnostic runtime: `yukl render` and `yukl verify` (`scripts/yukl.js`)
  plus a `verify-contract` CI job for committed Rational Persuasion contracts,
  designed to be the merge gate and blocking merges once it is configured as a
  required status check on the default branch (task B).
- Committed contract evidence: `.orchestration/contracts/*.json` is now
  tracked in version control (tasks A, B and C).
- Phase 5 scoping note in `docs/SDLC_PLAN.md` (task C).
- `AGENTS.md` mirroring `CLAUDE.md` with a byte-identity sync test (task A).
- Repo-wide gate config `yukl.config.json` (commands, folders, the
  proof-command allowlist) and per-task intents at
  `.orchestration/intents/<task_id>.yml` (goal, allowed and forbidden paths,
  assumptions, consultation), validated by `npm run build` (task G).
- `yukl verify` path enforcement: each file a contract covers must match the
  task intent's `allowed_paths` and no `forbidden_paths` (forbidden wins),
  matched by a small in-house glob (literal paths, `*` for one segment, `**`
  for any depth); a contract's `files_touched` must be a subset of the diff
  (task G).
- `yukl verify --base` refuses a contract that already exists at the base
  ref with "contract `<task_id>` is already merged at `<base>`; an intent
  authorises one PR, so use a new task_id", so a PR cannot rewrite a merged
  contract to inherit that task's merged intent (task G).
- `.orchestration/intents/**` is doc-exempt, so a PR that only adds an intent
  file passes `verify --base` without a contract and the intent-first
  workflow ("merge the intent first") can go through the gate; a PR carrying
  contracts must still cover a changed intent file in `files_touched`
  (task G).
- Documentation status: `README.md`, `docs/YUKL_ARCHITECTURE.md`,
  `docs/SDLC_PLAN.md`, `CLAUDE.md` and `AGENTS.md` opt in to the doc-status
  validator (the `<!-- yukl:doc-status -->` marker on the first line) and
  annotate every `##`/`###` section as `planned`, `background` or
  `implemented`, the last naming the test that proves it (v2-w4-docs).
- `docs/YUKL_ARCHITECTURE.md` section 4 documents the lifecycle runtime:
  `yukl run`, `yukl status` and `yukl decide`, the stage machine, the autonomy
  policy in `yukl.policy.json`, the earned-autonomy track record, the
  hash-chained per-task event log under `.orchestration/state/` and the run
  head committed as a `Yukl-Run-Head` trailer (v2-w4-docs).
- The architecture document and the README state the three known limits of the
  harness plainly: the shared GitHub identity, the Orca dispatch-guard gap and
  the uncommitted tail that no committed head covers (v2-w4-docs).

### Changed
- French & Raven (1959) describe sources of power and Yukl & Falbe (1990)
  describe influence tactics; the README no longer calls the two a unified
  model (task i).
- Architecture section 3.2 now points coalition tactics at the dual-pipeline
  review mode and consensus gate in sections 3.3 and 3.4, which remain review
  policy rather than a tool-enforced gate (task i).
- The kill, worktree-removal and retry loop is marked as planned behaviour in
  the README, architecture section 2.8, CLAUDE.md and AGENTS.md: `onFailGoto`
  and `maxRetries` are only checked for well-formedness and no code acts on
  them (task i).
- `onFailGoto` retry and process kill reclassified from a French & Raven base
  to structural design / enforcement in both mapping tables (task i).
- `yukl verify --base` now reads both the command allowlist and the task
  intent from the base ref via `git show`, never from the working tree or
  HEAD, so a PR cannot widen its own allowlist or path scope; an intent that
  exists only in the PR fails with "intent for `<task_id>` not found at
  `<base>`; merge the intent first" (task G).
- The root `.yukl-intent.yml` is kept as a legacy fallback for one release,
  used only when `yukl.config.json` is absent; without `--base`, verify reads
  the working tree and is a developer preview rather than a trust boundary,
  and a contract whose intent file is absent gets a warning instead of a
  failure, so repositories with pre-intent contracts keep `npm run verify`
  green (task G).
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
- The lock broker's stale reclaim is atomic against a rival acquirer: reclaim
  now runs under an exclusive `<name>.lock.reclaim` guard and re-reads the lock
  before removing it, so two acquirers that both see a dead owner can no longer
  both remove and both end up holding the lock; a stale guard is reclaimed like
  any stale lock (v3-unattended).
- The unattended-loop tests fail fast instead of hanging when a run limit stops
  firing: their fake sleep and fake runtime are bounded, so a loop with no exit
  throws after a generous number of polls or agent starts. An immediately
  resolving sleep starves the event loop, which is why the test runner's own
  timeout could never end the hang (v3-unattended).
- `yukl schedule` reads each task's intent from `--base` through `git show`, as
  `yukl run --base` reads its config and policy, so a task branch can no longer
  widen the `allowed_paths` its own scheduling is planned from; without `--base`
  the working tree stays a documented local preview (v3-unattended).

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
