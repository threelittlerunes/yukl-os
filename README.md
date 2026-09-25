<!-- yukl:doc-status -->
# Yukl-OS: The Power-Based Agent Harness

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Build Status](https://github.com/threelittlerunes/yukl-os/actions/workflows/ci.yml/badge.svg)](https://github.com/threelittlerunes/yukl-os/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/badge/npm-v2.0.0-blue.svg)](package.json)

> **Govern your agents; do not plead with them.**

Yukl-OS maps French & Raven's bases of power and Yukl's influence tactics onto deterministic pipeline constraints, so an AI workforce is bounded by architecture rather than by good intentions in a prompt.

## Key features
<!-- status: background -->

### Cognitive budget enforcement
<!-- status: implemented tests=tests/rules.test.js#every rule file stays inside its instruction budget (AF-4) -->
Instruction counts are measured and capped, so "too much context" fails the build instead of degrading silently.

### Empirical proof contracts
<!-- status: implemented tests=tests/yukl.test.js#verify passes a known-good contract with allowlisted commands -->
An agent cannot finish a task without writing executable proof to `.orchestration/contracts/<task_id>.json`, which `yukl verify` executes before a merge.

### Path-scoped progressive disclosure
<!-- status: implemented tests=tests/rules.test.js#CLAUDE.md section 2 routes every rule file (V-1) -->
An agent receives only the rule files matching the paths it is allowed to touch, and the build checks that the root router points at every rule file.

### Unattended runs and run limits
<!-- status: implemented tests=tests/command-run.test.js#an unattended run stops on a breached agent-start limit and records it -->
`yukl run <task_id> --unattended` keeps driving one task until it is terminal, needs a human, escalates or breaches a run limit, waiting for running stages instead of stopping on them. The two run limits (`maxWallMinutesPerRun`, `maxAgentStartsPerRun`) are enforced: a breach appends an `enforcement` event and stops the run. They bound every run, attended or unattended - an attended run stops on a breach too - and `--unattended` changes only how the loop behaves between steps and is refused while a limit is unset.

### Parallel scheduling and advisory locks
<!-- status: implemented tests=tests/command-schedule.test.js#schedule runs a wave concurrently and starts the next wave only after it settles -->
`yukl schedule` drives several tasks unattended, each in its own Git worktree: tasks whose `allowed_paths` do not overlap run in parallel and overlapping ones are serialised, with a `.orchestration/locks/` advisory lock per task so no two schedulers drive the same task. With `--base` each task's intent is read from that ref through `git show`, so a task branch cannot widen its own scope; without it the working tree is a local preview.

## Planned features
<!-- status: planned -->

- **Coercive retry loops** - a failed audit would route the work deterministically back to implementation, up to `maxRetries`. The intervention table and the stage machine exist; the process kill and worktree removal do not.
- **The Phase 5 feedback loop** - see [docs/SDLC_PLAN.md](docs/SDLC_PLAN.md).

## Pipeline
<!-- status: background -->

```mermaid
flowchart LR
    A["INTENT.md"] --> B["Legitimate Power\n(Scope Lock)"]
    B --> C["Expert Power\n(Isolated Drafter)"]
    C --> D["Rational Persuasion\n(Proof Contract)"]
    D --> E["Audit\n(Expert Power)"]
    E -->|PASS| F["Merge"]
    E -. "FAIL (retry planned)" .-> C
    G["Information Power\n(Progressive Disclosure)"] -.-> C
```

## Quick Start
<!-- status: implemented tests=tests/init.test.js#init a node-only repo: detected commands, null for the rest, checkout-sha pin -->

**1. Install and verify the harness.**

```sh
git clone https://github.com/threelittlerunes/yukl-os.git
cd yukl-os
npm install
npm run build   # validate the harness configuration
npm run test    # instruction-budget check + test suite
```

Node 20 or newer is required.

**2. Install the harness into your project.**

```sh
node scripts/yukl.js init --cwd /path/to/your-project
```

From a feature branch of a Git repository (a clean tree, not the default
branch, not detached), `yukl init` writes `yukl.config.json` with the commands
it detects from `package.json` and `pyproject.toml` (undetected commands are
`null`, never guessed), appends a marked section to any existing `CLAUDE.md`,
`AGENTS.md` or `GEMINI.md`, and installs a CI workflow at
`.github/workflows/yukl.yml` that gates PRs on `yukl verify --base` running a
commit-pinned harness. Subdirectory projects are handled with
`--project-dir app` (auto-detected one level below the root when the root has
no project file), and `--command test=<cmd>` supplies a proof command when
none is detectable; without at least one proof command init refuses rather
than write an invalid config. The harness commit the CI runs must already be
pushed to the yukl-os remote, so push first or pass `--yukl-pin <sha>` - and
the pin must be at or after the task h merge, because the generated CI gate
fails closed when the pinned yukl produces no output (older yukl-os versions
exit 0 silently through the npm bin shim).
Re-run init after a merge to update the generated files, passing `--force` to
overwrite an existing config; everything else is left alone.

**3. Declare your intent, then drive the lifecycle.**

```sh
cp INTENT.md /path/to/your-project/INTENT.md
```

Edit `INTENT.md` with a one or two sentence objective, then run the task with
`yukl run <task_id>` from the repository root. The lifecycle commands are
described below.

## Lifecycle commands
<!-- status: implemented tests=tests/acceptance-a.test.js#AC1: the merged lifecycle anchors every event to the base and commits the run head -->

The v2 runtime drives one task through a fixed lifecycle and records every step
in a hash-chained log:

- `yukl run <task_id> [--unattended] [--once]` composes the event log, the
  stage machine, the autonomy policy, path enforcement, failure diagnosis and
  the runtime and VCS adapters named in the `lifecycle` block of
  `yukl.config.json`, then loops until the task blocks, needs a human,
  escalates or finishes. `--once` takes a single step. `--unattended` waits for
  a running stage instead of stopping on it and keeps driving the task until it
  is terminal, needs a human, escalates or breaches a run limit; it is refused
  unless both run limits in `yukl.policy.json` are positive integers. The two
  limits bound an attended run in the same way - a breach appends the same
  `enforcement` event and stops the run - so `--unattended` changes only how the
  loop behaves between steps. Every start is recorded before it is made: a
  stage whose previous `stage_starting` has no recorded outcome blocks with
  `R-NEEDS-HUMAN` instead of starting a second worker (a `yukl decide override
  --to <stage>` clears it), and a runtime whose `start` throws is recorded as a
  `stage_failed`, diagnosed like any other failure, and then surfaced as the
  run's error so the command still exits 1 with the message.
- `yukl vcs-sync [--cwd <dir>] [--bookmark <name>] [--json]` publishes the
  working copy `@` of a colocated Jujutsu workspace as the Git branch `yukl-wc`
  (or `--bookmark`), so a worker can be branched from the state the human has on
  disk; it never edits `@` or its description. `yukl run` does the same before
  every agent start, and the worker branches from that ref even when `--base` is
  given - `--base` governs the config, policy, enforcement and merge target the
  run reads, not where the worker starts. It fails closed while Jujutsu cannot
  prove the state: a `.jj` at or above the working directory that jj cannot read,
  a conflicted, unreadable or remote-tracking bookmark, a custom bookmark that
  does not already point at `@`, or a Git ref that does not resolve to the
  exported commit. A plain Git repository is left alone (exit 0, nothing to
  publish). A run that knows no base tells Orca to use the repository's default
  base by omitting `--base-branch` from `worker-start` entirely, never by
  passing an empty string.
- `yukl schedule <task_id>... [--base <ref>]` drives several tasks unattended,
  each in its own worktree under `.orchestration/worktrees/`. Tasks whose
  intents' `allowed_paths` cannot overlap run in the same wave, in parallel;
  overlapping ones are serialised into later waves. Each task takes a
  `.orchestration/locks/<task_id>.lock` advisory lock while it runs. With
  `--base` every task's intent is read from that ref through `git show`, so a
  task branch cannot widen the scope it is scheduled from; without `--base` the
  working tree is read, which makes local mode a developer preview rather than a
  trust boundary.
- `yukl lock <hold|status|release> <name> [--task <id>] [-- <command>]` is the
  advisory lock broker: `hold` acquires the lock, runs the command and releases
  it however the command ends, and a lock whose recorded process is gone is
  reclaimed by the next acquirer under an exclusive `<name>.lock.reclaim`
  guard, so two acquirers can never both hold it.
- `yukl render <stage-id> [--config <path>] [--task-id <id>]` prints one stage's
  prompt with `{out}`, `{reads}` and `<task_id>` substituted, so a stage can be
  inspected without running an agent.
- `yukl verify [<contract-path>...] [--base <ref>]` runs the Rational Persuasion
  gate: it executes each contract's proof commands from the allowlist and
  enforces that contract's `files_touched` against the task intent, reading the
  allowlist and the intents from `<base>` through `git show` when given, so a
  pull request cannot widen its own scope.
- `yukl status <task_id> [--state-dir <dir>] [--base <ref>]` folds the log to
  its state, prints the last decision, verifies the hash chain and checks the
  log against the newest `Yukl-Run-Head` trailer on the base branch.
- `yukl decide <pause|resume|override|stop|approve> --task <id> --by <name>
  --reason <text>` records a human decision; it is refused while
  `YUKL_DISPATCH_ID` is set, so a dispatched agent cannot impersonate the
  human.
- `yukl init [--cwd <dir>] [--force] [--yukl-pin <sha>]` installs the harness
  into a project rather than driving a task, so Quick Start section 2 documents
  it.

Which transitions may advance without a human is set by `yukl.policy.json`, and
the per-task state lives under `.orchestration/state/` (git-ignored). The full
contract, including the known limits of these guarantees, is in section 4 of
[docs/YUKL_ARCHITECTURE.md](docs/YUKL_ARCHITECTURE.md).

## How It Works
<!-- status: background -->

```mermaid
flowchart TD
    classDef default fill:#f8f9fa,stroke:#dee2e6,stroke-width:1px,color:#212529;
    classDef agent fill:#ffffff,stroke:#343a40,stroke-width:2px,color:#212529,font-weight:bold;
    classDef contract fill:#e9ecef,stroke:#adb5bd,stroke-width:1px,color:#495057;

    Intent["System Intent (INTENT.md)<br/><i>[Yukl: Consultation]</i>"]
    
    subgraph Governance ["Governance Layer <i>[Legitimate Power]</i>"]
        Scope["Scope Lock Broker<br/><i>[Situational Control]</i>"]
        Rules["Progressive Disclosure<br/><i>[Informational Power]</i>"]
    end
    
    Drafter{"Drafter Agent (Isolated Worktree)<br/><i>[Expert Power]</i>"}:::agent
    
    Contract["Empirical Proof Contract<br/><i>[Yukl: Rational Persuasion]</i>"]:::contract
    
    Auditor{"Auditor Agent (Final Gate)<br/><i>[Expert Power]</i>"}:::agent
    
    Merge(["Integration & Merge"])
    
    Intent --> Governance
    Governance --> Drafter
    Drafter -->|Generates verifiable proof| Contract
    Contract --> Auditor
    
    Auditor -->|Pass| Merge
    Auditor -. "Fail (Process Kill & Retry)<br/>[planned]" .-> Drafter
```

Yukl-OS draws on two distinct organisational-psychology frameworks: **French & Raven's six bases of power** (where influence comes from) and **Yukl's eleven influence tactics** (how influence is attempted). The harness maps each mechanism onto one concept from those frameworks.

| Harness mechanism | Framework | Concept |
|---|---|---|
| Root `CLAUDE.md` router | French & Raven base | Legitimate power |
| Path-scoped rules (`.claude/rules/*.md`) | French & Raven base | Informational power |
| Drafter (specialist implementation) | French & Raven base | Expert power |
| Auditor (independent judgement) | French & Raven base | Expert power |
| Contract verification loop | Yukl tactic | Rational persuasion |
| Mandatory human scope interview | Yukl tactic | Consultation |
| `onFailGoto` retry and process kill (planned) | Structural design | Enforcement (engineering control) |
| Isolated Git worktree and lock broker | Structural design | Environment shapes behaviour |

French & Raven (1959) describe the sources of power; Yukl & Falbe (1990) describe the eleven influence tactics. The two are distinct frameworks.

Two non-mappings are deliberate. **Referent power** (influence through admiration) is a human social mechanism with no meaningful agent equivalent, so the harness does not claim it. **Reward power** is a known gap, recorded in section 3.2 of the architecture document.

## Agent support
<!-- status: background -->

The harness is agent-agnostic. `CLAUDE.md` carries the constitution for Claude Code, and `AGENTS.md` carries the same rules for agents that read AGENTS.md. Whichever agent writes the code, the deterministic checks - `npm run build`, `npm run test` and CI - are the binding layer that verifies it.

## Architecture
<!-- status: background -->

The harness treats the repository as a constitution and the pipeline as its enforcement. A router stage establishes the scope, a Drafter implements inside an isolated worktree, and an Auditor executes the Drafter's empirical proof before approving the work. Instruction budgets, path-scoped rules and advisory locks keep every agent inside its lane. The full rationale, the 12-Factor Agents gap analysis and the known capability gaps live in [docs/YUKL_ARCHITECTURE.md](docs/YUKL_ARCHITECTURE.md).

## Contributing
<!-- status: background -->

Contributions are held to the standard the harness enforces: small scope, empirical proof, no vibes. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution contract, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for participation. Report vulnerabilities per [SECURITY.md](SECURITY.md), not in a public issue.

## Licence
<!-- status: background -->

MIT - see [LICENSE](LICENSE).
