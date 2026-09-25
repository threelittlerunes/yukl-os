<!-- yukl:doc-status -->
# Yukl Power Harness: Agentic SDLC Architecture

**Version:** 2.0 (Advanced Configuration)
**Foundations:** French & Raven's bases of power, Yukl's influence tactics, Dex Horthy's 12-Factor Agents, ETH Zurich context-dilution limits.

---

## 1. The Core Problem: Cognitive Dilution & Anthropomorphism
<!-- status: implemented tests=tests/rules.test.js#every rule file stays inside its instruction budget (AF-4) -->
The primary failure mode of Agentic SDLCs is not capability, but **Context Dilution**. Frontier models suffer a probabilistic collapse in instruction adherence when system prompts exceed roughly 150 concurrent instructions. When a "vibecoder" stuffs testing conventions, database schemas, and architectural guidelines into a single `CLAUDE.md`, the model's attention mechanism degrades. It begins to ignore critical security constraints just as frequently as it ignores minor styling preferences.

This claim is measured, not asserted. `scripts/count-instructions.js` counts the directives injected by the root file and every path-scoped rule, and `npm test` fails when any file - or the system as a whole - exceeds its budget.

Furthermore, assigning generic, monolithic roles to agents ("Be a senior developer") fails to establish the organizational friction required for robust software engineering.

## 2. Two Frameworks: Bases of Power and Influence Tactics
<!-- status: background -->

The harness draws on **two distinct** organisational-psychology frameworks. They are frequently conflated, so this document keeps them separate throughout.

### 2.1 French & Raven: Bases of Power
<!-- status: background -->
French & Raven (1959) describe the *sources* of an agent's power - where the ability to influence comes from.

| Base | Source of influence |
|---|---|
| Legitimate | Positional authority in the hierarchy |
| Reward | Ability to grant benefits |
| Coercive | Ability to punish or restrict |
| Expert | Specialist knowledge or skill |
| Referent | Identification with, or admiration of, the holder |
| Informational | Control over the flow of information (added later by Raven) |

The original paper described five bases; informational power was added later by Raven, giving the commonly cited set of six.

### 2.2 Yukl: Proactive Influence Tactics
<!-- status: background -->
Yukl & Falbe (1990) describe *how* influence is attempted - the observable behaviours, of which there are **eleven** proactive tactics.

| # | Tactic | # | Tactic |
|---|---|---|---|
| 1 | Rational persuasion | 7 | Coalition tactics |
| 2 | Inspirational appeals | 8 | Legitimating tactics |
| 3 | Consultation | 9 | Pressure |
| 4 | Ingratiation | 10 | Apprising |
| 5 | Personal appeals | 11 | Collaboration |
| 6 | Exchange | | |

Neither framework has twelve of anything: French & Raven give six bases, Yukl gives eleven tactics. References to "12 bases" are incorrect.

### 2.3 Mapping the Harness onto Both Frameworks
<!-- status: background -->

| Harness mechanism | Framework | Concept |
|---|---|---|
| Root `CLAUDE.md` router | French & Raven base | Legitimate power |
| Progressive disclosure / path-scoped rules | French & Raven base | Informational power |
| Drafter (specialist implementation) | French & Raven base | Expert power |
| Auditor (independent judgement) | French & Raven base | Expert power |
| Contract verification loop | Yukl tactic | Rational persuasion |
| Mandatory human scope interview | Yukl tactic | Consultation |
| `onFailGoto` retry and process kill (planned) | Structural design | Enforcement (engineering control) |
| Situational control (isolated environment) | Structural design | Environment shapes behaviour |

Two deliberate non-mappings are worth recording. **Referent power** - influence through admiration or identification - is a human social mechanism with no meaningful agent equivalent; the harness does not claim it. **Reward power** is listed as a known gap in section 3.2.

### 2.4 Legitimate Power (The 60-Line Root Imperative)
<!-- status: implemented tests=tests/rules.test.js#CLAUDE.md stays under the 60-line root cap -->
*Authority through hierarchical position.*
The root `CLAUDE.md` is the system's constitution. It is restricted to **no more than 60 lines** and is checked by `scripts/count-instructions.js`. It must pass the *Discoverability Test*: if an agent can infer a rule by reading the code, the rule is excluded. The root file states the agent's Legitimate Power, acting purely as a router that points agents to their specialized scopes.

### 2.5 Information Power (Progressive Disclosure)
<!-- status: implemented tests=tests/rules.test.js#all path-scoped rules declare frontmatter paths (IC-8) -->
*Control over critical data flow.*
To respect the instruction limit, we weaponize Information Power. Context is aggressively withheld from agents until necessary, using **path-scoped rule files** (`.claude/rules/*.md` with YAML frontmatter).
- If an agent touches `src/api/**`, it is granted `.claude/rules/drafter-api.md`.
- If it touches `src/ui/**`, it is denied the API rules and granted `.claude/rules/drafter-ui.md`.

This ensures the instruction budget is spent exclusively on the immediate task.

### 2.6 Expert Power (Role-Based Partitioning)
<!-- status: background -->
*Influence through specialized knowledge.*
We abandon the monolithic generalist agent and partition execution across isolated **Git worktrees** using specialized agents.
- **The Executive Orchestrator:** Holds Legitimate Power. Manages `flow.config.json` and delegates tasks. Never writes code.
- **The Drafter:** Holds Expert Power. Operates in an isolated Git worktree. Its system prompt is aligned purely for deep implementation.
- **The Auditor:** Holds Expert Power (independent specialist judgement). Its instruction budget is spent entirely on verification.

### 2.7 Rational Persuasion (The Empirical Contract)
<!-- status: implemented tests=tests/yukl.test.js#verify passes a known-good contract with allowlisted commands -->
*Influence through logical argument and evidence.*
An agent cannot complete a task via "vibes." It must exercise **Rational Persuasion**. Before the Drafter can request an audit, it must generate a deterministic payload at `.orchestration/contracts/<task_id>.json` containing empirical proof of success:
- Exact `curl` commands and expected HTTP codes.
- Test-runner output hashes.
- AST compilation logs.

The Auditor ingests this contract and verifies the claims autonomously.

### 2.8 Enforcement Controls (Tandem State Broker & Kill-Switches)
<!-- status: planned -->
*Deterministic enforcement, not a base of power.*
Because parallel agents operating in isolated worktrees will eventually encounter race conditions (for example both running `npm install`), the system uses an advisory **lock broker**. Agents acquire ephemeral `.lock` files in `.orchestration/locks/` before mutating shared resources.

If an agent hallucinates a non-existent API, violates its path-scope, or fails the Auditor's contract check, the planned enforcement is to kill the process, remove the Git worktree (`git worktree remove`) and restart the loop with a penalization prompt. This is planned behaviour, not implemented: `onFailGoto` and `maxRetries` in `flow.config.json` are only checked for well-formedness by `scripts/validate-config.js`; no code acts on them.

---

## 3. Implementation Blueprint
<!-- status: background -->

By adopting this architecture, your repository becomes a self-regulating organization. You no longer prompt the AI; you govern the pipeline. See the accompanying `CLAUDE.md` and `.claude/rules/` directory for the optimized implementation of this framework.

### 3.1 12-Factor Agents: gaps and planned remediations (AF-8)
<!-- status: background -->

The harness is evaluated against Dex Horthy's 12-Factor Agents. Several factors are only partially met and two are explicitly out of scope. Honest status:

| Factor | Status | Remediation |
|---|---|---|
| 5. Compact errors into context | GAP | Carry the Auditor's stderr into the retry prompt instead of restarting the step cold. |
| 6. Own your control flow | PARTIAL | Control flow stays with the pipeline by design; document it as a deliberate constraint, not an oversight. |
| 2. Agent owns its own context | PARTIAL | Add a mechanism for an agent to request an expanded path scope through the router stage. |
| 4. Unify execution and planning | PARTIAL | Keep the Drafter/Auditor separation for trust reasons; allow a plan-first Drafter mode. |
| 8. Own your auth | NOT ADDRESSED | Out of scope for a local harness; adopters supply their own auth. |
| 11. Deploy progressively | NOT ADDRESSED | Out of scope; the harness has no runtime to deploy. |

Addressed in this release: factor 10 (test like software) via `npm test`; factor 12 (log and trace everything) via `.orchestration/artifacts/README.md`; factor 9 (embed in developer workflows) via the CI workflow.

### 3.2 Known capability gaps
<!-- status: planned -->

- **Reward power** has no mechanism. There is no positive-reinforcement signal (priority boost, larger token budget) for good work. Planned: a stage-level score that raises the Drafter's retry budget after clean audits.
- **Coalition tactics** map to the dual-pipeline review mode and consensus gate in sections 3.3 and 3.4: a severe finding must be confirmed by a second, independent pass before it can block a merge. The consensus rule is a review policy, not enforced by a tool.
- **Log retention** is documented but not yet enforced by a scheduled purge.

### 3.3 Dual-pipeline review mode
<!-- status: background -->

`review.config.json` encodes an optional A/B review pattern for changes that
warrant more scrutiny than the single auditor in `flow.config.json`. Two
independent analysis passes run the **same prompt template** against the same
implementation, each writing to a separate output path
(`.orchestration/artifacts/review-a.md` and `review-b.md`). A consensus stage
(`claude`) then reads both outputs and extracts the findings.

Independent passes reduce false positives: neither pass sees the other's
report, so a hallucinated finding in one cannot seed the same hallucination in
the other. Findings reported by **both** passes are treated as confirmed;
findings reported by only one are flagged for human triage rather than being
silently dropped.

This is an optional, documented capability. The default pipeline remains the
single auditor in `flow.config.json`.

### 3.4 Consensus-gating rule
<!-- status: background -->

A single auditor pass is fallible, so the harness defines a consensus gate for
severe findings. A **P0 or P1 finding from a single pass must be confirmed by a
second, independent pass before it can block a merge**. Two passes that agree
elevate the finding to a blocking verdict.

A finding reported by only one pass is not silently dropped: it is escalated to
human review, where a person decides whether it is real or a false positive.
P2 findings never block a merge on their own.

The consensus-gating rule is a review policy, not an automated gate: no tool
enforces it. Any agent can render the review stages with
`yukl render <stage> --config review.config.json --task-id <id>`, which prints
each stage's prompt with its placeholders filled in; running the two passes
and the consensus step is done by agents or people. The deterministic merge
gate is the `verify-contract` CI job (`yukl verify`) plus the `validate` job,
both required status checks on `main`. Consensus review is supplementary
judgement on top of that gate, never a replacement for it.

### 3.5 The split gate: repo-wide config and per-task intents
<!-- status: implemented tests=tests/intent-gate.test.js#verify --base exits 0 when base has yukl.config.json and the task intent -->

`yukl verify` enforces two kinds of rules, now read from two different places
instead of one root file:

- **`yukl.config.json`** holds repo-wide settings: the `commands` shortcuts
  (`build`, `test`, `format`), the `folders` layout, and the `allowlist` of
  proof commands the gate may execute.
- **`.orchestration/intents/<task_id>.yml`** holds one task's intent: its
  goal, `allowed_paths`, `forbidden_paths`, assumptions, and consultation
  flag. One file per task isolates merge conflicts.

The **trust model is locked to the base ref.** With `--base`, `yukl verify`
reads both files from the base ref via `git show`, never from the working
tree or HEAD: a PR can neither widen its own allowlist nor its own path scope.
An intent that exists only in the PR fails with "intent for `<task_id>` not
found at `<base>`; merge the intent first", so a task's intent must be merged
before its implementation PR. Symmetrically, **one intent authorises one PR**:
a contract that already exists at the base ref fails with "contract
`<task_id>` is already merged at `<base>`; an intent authorises one PR, so use
a new task_id". Without that rule a PR could rewrite a merged contract and
inherit that task's merged, possibly broad, intent to cover new files.

For every verified contract, each file in its `files_touched` must match one
of the intent's `allowed_paths` and none of its `forbidden_paths` (forbidden
wins); violations are listed by file. The matcher is a small in-house glob
supporting literal paths, `*` (one path segment) and `**` (any depth):
`tests/*.js` does not match `tests/x/y.js`, while `tests/**` does. Contract
files themselves are exempt because their path is derived from the verified
`task_id`. A contract's `files_touched` must also be a subset of the files
changed in the diff, and every diff file must be covered by a contract.

The intent-first workflow is possible because `.orchestration/intents/**` is
**doc-exempt**: a PR that only adds an intent file passes `verify --base`
without a contract. That grants no scope by itself - an intent is a scope
decision made by the human who merges it, and it takes effect only once it is
merged into the base. In a PR that does carry contracts, a changed intent
file is no longer exempt: it must be covered by a contract's `files_touched`
and match that intent's own paths, like any other file.

Without `--base`, `yukl verify` runs the same checks against the working
tree. That local mode is a developer preview, not a trust boundary: it trusts
the working-tree copies of the config and intents, and it checks every
contract in the repository. A contract whose intent file is absent only gets
a warning ("no intent for `<task_id>` (pre-intent contract); paths not
enforced"), so repositories carrying pre-split legacy contracts (tasks a-f
here) keep `npm run verify` green; a present-but-invalid intent or a path
violation still fails. The `--base` gate is strict either way: a missing
intent at the base ref still fails, and it only ever checks contracts
present in the diff.

The root `.yukl-intent.yml` is kept as a **legacy fallback for one release**,
used only when `yukl.config.json` is absent, so repositories that predate the
split keep verifying. It will be removed once adopters have migrated. The PR
that introduced this section was itself verified by the old gate, because its
base carried only `.yukl-intent.yml`; path enforcement applies from the next
PR onwards.

`npm run build` validates the `yukl.config.json` schema and every intent file
in `.orchestration/intents/`, alongside the repo-only governance checks.

### 3.6 Installing the harness: `yukl init`
<!-- status: implemented tests=tests/init.test.js#init a node-only repo: detected commands, null for the rest, checkout-sha pin -->

`yukl init [--cwd <dir>] [--force] [--yukl-pin <sha>] [--project-dir <rel>]...
[--command <key>=<cmd>]...` installs the harness into a target repository on a
feature branch, never overwriting anything the repository already has.
Refusals (exit 1, nothing written) are decided before any write: not a Git
repository (task e's `.git`-or-colocated rule), HEAD on the default branch, a
detached HEAD, or a dirty working tree. **Colocated Jujutsu** is the
exception: jj keeps git HEAD detached by design, so there the detached-HEAD
refusal is replaced by refusing only while the working-copy commit (`@`) is
still the default branch's tip - the jj analogue of "on the default branch",
because jj bookmarks follow `@` and edits made on the tip would advance the
default branch itself.

Project files are read from the repository root and, via `--project-dir`, from
named subdirectories; when the root has neither `package.json` nor
`pyproject.toml`, directories exactly one level below the root are scanned and
any holding one of those files is auto-detected with a warning (the pathfinder
layout: Python under `app/`). Commands for a subdirectory project carry a
`cd <dir> && ` prefix because `verify` executes allowlisted commands from the
repo root; the generated CI is Linux-only (`ubuntu-latest`, sh), and `cd X &&
CMD` is equally valid in sh, cmd and PowerShell, so the same command runs
locally on Windows.

Init writes four kinds of files:

- **`yukl.config.json`** - detected commands only: `package.json` scripts map
  to `npm run build|test|format|lint`, and a **line-based scan** of
  `pyproject.toml` records `ruff check` (`python -m ruff check` in a
  subdirectory) for a `[tool.ruff]` header and `pytest` (`python -m pytest`)
  for a `[tool.pytest...]` header. The scan is not a TOML parse: headers must
  start at column 0 and no other tools are detected. Anything undetected is
  written as `null` with a warning, never guessed; `--command <key>=<cmd>`
  supplies or overrides commands, and init refuses outright when the resulting
  allowlist would be empty (an empty allowlist would fail the config schema).
  An existing config is left alone unless `--force` is passed.
- **Agent docs** - any existing `CLAUDE.md`, `AGENTS.md` or `GEMINI.md` gains
  a section between `<!-- yukl:begin -->` and `<!-- yukl:end -->` markers;
  everything outside the markers is preserved byte for byte and a second run
  replaces only the marked section (idempotency). Missing docs are skipped
  with a warning rather than created.
- **CI** - `.github/workflows/yukl.yml` sets up Node (to run yukl) and, when a
  Python command was detected, Python. It installs the Python project with its
  dev extras (`pip install -e "app[dev]"`) when `pyproject.toml` declares a
  `dev` or `test` extra under `[project.optional-dependencies]`; otherwise it
  installs the detected tools (`pip install ruff pytest`) and warns. It runs
  the detected checks - each line in its own subshell, so a `cd <dir> && `
  prefix cannot leak into the next line - and gates the PR on
  `yukl verify --base origin/<base_ref>`. The yukl it runs is
  **commit-pinned**: `npm exec --package=github:threelittlerunes/yukl-os#<sha>`
  with the SHA taken from `--yukl-pin` or detected from the harness checkout -
  never a floating ref. **The pin must be at or after the task h merge**: the
  verify step captures yukl's output and exit status and, when the output
  contains no check line (no line starting with `PASS` or `FAIL`), prints
  "yukl produced no output; the pinned version `<sha>` cannot run via the npm
  bin shim, so pin a release that includes task h" and exits 1 - a yukl-os
  commit from before the task h bin-shim fix exits 0 silently through npm's
  `.bin` shim, and without the guard the gate would pass every PR. A failing
  verify still surfaces its output (`set +e` around the capture) and the step
  exits with verify's status. Before writing, init verifies the pin is
  actually pushed to the yukl-os remote (local remote-tracking branches first,
  `git ls-remote` as fallback): an unpushed pin refuses with "pin `<sha>` is
  not pushed; push it or pass `--yukl-pin <pushed sha>`". The check fails
  closed offline; `YUKL_PIN_CHECK=off` skips it with a warning.
- **Orchestration dirs** - a `.gitkeep` placeholder inside each of
  `.orchestration/contracts/` and `.orchestration/intents/` so the empty
  directories are trackable in Git.

The first init PR is bootstrapped by human review: the generated CI first
checks `git cat-file -e origin/<base_ref>:yukl.config.json`; when the base has
no config, the job prints "bootstrap: harness not installed at base; this PR
is gated by human review" and exits 0, and `verify` starts enforcing from the
next PR on.

`scripts/yukl.js` decides whether it is the CLI entry point by comparing the
realpaths of `import.meta.url` and `process.argv[1]`, which works through
npm's `.bin` shim (a symlink on Linux, a `.cmd` wrapper on Windows) and still
refuses to run when the module is imported by the test runner.

---

## 4. The Lifecycle Runtime
<!-- status: background -->

Section 3 documents the gates that check work. This section documents the v2
runtime that carries a task through those gates: the commands, the state they
read and write, the policy that decides who may advance a transition, and the
limits of what the harness can prove. Nothing here claims a guarantee the code
and its tests do not provide.

### 4.1 The stage machine
<!-- status: implemented tests=tests/lifecycle-stages.test.js#the full happy path reaches done when every edge is anchored -->

`scripts/lifecycle/stages.js` is a pure state machine over the ordered stages
`intent`, `scope`, `plan`, `implement`, `prove`, `audit`, `review`, `integrate`
and the terminal states `done`, `stopped` and `escalated`. An agent may only
move the lifecycle forward by finishing the current stage with a `stage_done`
event that carries a 40-hex commit anchor; an unanchored or malformed edge is
refused (`R-NO-ANCHOR`), and a verdict from the same actor that implemented the
stage is refused as self-approval (`R-SELF-APPROVAL`). A human may move the
lifecycle anywhere with a `human_decision` event, including pause, resume and
stop. `done` and `stopped` are closed to every event; `escalated` is closed to
agents but a human can pull the task out of it. The `scope` stage may skip
`plan` only when the skip records a decision rule.

### 4.2 `yukl run`
<!-- status: implemented tests=tests/command-run.test.js#run --once drives one stage with the configured adapter and agent -->

`yukl run <task_id> [--unattended] [--once] [--cwd <dir>] [--base <git-ref>]`
is the composition root. It loads the per-task event log, the stage machine,
the anchors, path enforcement, the failure diagnosis and the runtime and VCS
adapters named in the `lifecycle` block of `yukl.config.json`, then drives the
task: with `--once` it takes a single engine step, otherwise it loops until the
lifecycle is terminal, a stage needs a human, the diagnosis escalates, a stage
is running or a gate is unsatisfied, or 64 steps have passed; the two run
limits (section 4.7) bound that loop too, so an attended run stops on a breach
exactly as an unattended one does. `--unattended` replaces the step cap with the
run limits: the loop waits for a running stage instead of stopping on it and
keeps driving the task until it is terminal, needs a human, escalates or
breaches a run limit, and it is refused
before any adapter starts unless both run limits are positive integers. The
exit code is 0 when the run advanced or stopped cleanly, 1 on a refusal, an
enforcement stop or an error, and 2 on a usage problem. With `--base`, the
`lifecycle` block and the policy are read from that ref through `git show`, so a
task branch cannot name its own runtimes; without `--base` the working tree is
read, which is a local preview rather than a trust boundary. In a Jujutsu
workspace (section 4.15) every agent start first publishes the working copy as
the Git branch `yukl-wc`, and the worker branches from that ref even when
`--base` is given, because `--base` governs what the run reads - the config, the
policy, path enforcement and the merge target - not where the worker starts.

### 4.3 `yukl status`
<!-- status: implemented tests=tests/command-status.test.js#an untouched log with a committed head exits 0 and reports its uncommitted tail -->

`yukl status <task_id> [--state-dir <dir>] [--base <ref>]` folds the task's
log to its state (the stage, the attempt count and the event count), prints the
last recorded decision (its rule, its rationale, or a human decision with its
reason), verifies the hash chain and, when the base branch carries a
`Yukl-Run-Head: <task_id> <hash>` trailer for the task, checks that the log
still contains the committed head and reports how many events follow it. It
exits 0 when the chain verifies and any committed head is found, 1 on a broken
chain, a missing log, an unreadable base or a head the log no longer contains,
and 2 on a usage error. The state directory defaults to `.orchestration/state`
from the working directory and the base to `main`.

### 4.4 `yukl decide`
<!-- status: implemented tests=tests/command-decide.test.js#any call with YUKL_DISPATCH_ID set exits 1 and appends nothing -->

`yukl decide <pause|resume|override|stop|approve> --task <id> --by <name>
--reason <text> [--to <stage>] [--state-dir <dir>]` appends exactly one
`human_decision` event with the actor `human:<by>`. `override` requires `--to`
to name a lifecycle stage and, like `stop`, moves the stage; `pause` and
`resume` set or clear the paused flag; `approve` re-affirms the current stage.
A decision on a task whose folded state is terminal exits 1 naming the rule,
and any call while `YUKL_DISPATCH_ID` is set exits 1, because a dispatched
agent holds no human authority. A usage problem exits 2. In every refusal the
log is left byte for byte intact.

### 4.5 The autonomy policy
<!-- status: implemented tests=tests/lifecycle-policy.test.js#requiresHuman maps human, auto and auto_at_level and fails closed -->

`yukl.policy.json` maps each transition id to `"human"`, `"auto"` or
`{ auto_at_level: n }`, and sets a `ceiling`, an attempt limit and the two run
limits (section 4.7). `requiresHuman(policy, transitionId, level)` returns true
for `"human"`, false for `"auto"`, and for `{ auto_at_level: n }` needs a human
below level `n`. An unknown transition id, or a value that is neither form,
fails closed and needs a human. The committed policy makes stage advances,
within-limit retries, implementation merges, enforcement stops, autonomy
decreases and reopens automatic, and keeps merging an intent or policy PR,
raising a budget or ceiling, answering an escalation, bootstrapping init,
abandoning a task and starting an unattended run human. `--base` reads the
policy from that ref, so a pull request cannot widen its own autonomy.

### 4.6 Earned autonomy
<!-- status: implemented tests=tests/lifecycle-track.test.js#autonomyLevel raises to each reached threshold and clamps to the ceiling -->

How much a runtime may do without a human is earned from what it has recorded,
never from what it claims. `trackRecord` folds a task's events into one
runtime's clean audits, failed audits and enforcement stops; only
`audit_verdict` and `enforcement` events carry weight, and an `autonomy_change`
event is never counted whatever actor wrote it. `autonomyLevel` raises the
level to each reached threshold in `policy.trackRecord.levels` in ascending
order, clamps it to `ceiling` and subtracts one for any enforcement stop. With
the committed policy, five clean audits earn level 1.

### 4.7 Run limits and unattended runs
<!-- status: implemented tests=tests/command-run.test.js#an unattended run stops on a breached agent-start limit and records it -->

`yukl.policy.json` declares exactly two run limits under `budgets`:
`maxWallMinutesPerRun` and `maxAgentStartsPerRun`, each a positive integer or
`null`. There is no token limit: no adapter can measure tokens, so it must not
exist as a setting, and a policy that carries one is refused by the schema
(`budgets.maxTokensPerRun is not a run limit`). A `null` limit is unset, which
keeps every run attended: `yukl run --unattended` is refused before any adapter
is started while either limit is unset, because a loop with no wall-clock bound
has no bound at all. The committed policy ships both switched on - 120 minutes
and 12 agent starts per run.

The limits are enforced, not merely declared. An unattended loop measures its
own wall clock against `maxWallMinutesPerRun` before every step, so a stage that
is merely running cannot keep it alive past the limit; and it counts the agent
starts it has made itself (the `stage_started` events it appended, excluding the
`integrate` merge marker) against `maxAgentStartsPerRun` at the moment an agent
would start, so a run at its limit still waits for the agent it has already
dispatched instead of abandoning it. Either breach appends an `enforcement`
event carrying `rule: R-RUN-LIMIT` and the breached limit to the task's log and
stops the run, which exits 1; nothing is killed and nothing is penalised beyond
that stop, and because the count is run-scoped, a later run of the same task
starts with the limit unspent.

The limits bound every run, attended as well as unattended: `yukl run` hands the
policy's two values to the loop whatever its mode, the wall-clock check and the
agent-start refusal run on every step, and a breach records the same
`enforcement` event and stops the run with the same exit code. `--unattended`
changes only what the loop does between steps - it waits for a running stage
instead of stopping on it - and it is the only mode that is refused while a
limit is unset.

### 4.8 The event log
<!-- status: implemented tests=tests/lifecycle-events.test.js#editing any byte of an earlier line makes verifyChain fail naming that line -->

Each task's state is an append-only JSONL log at
`.orchestration/state/<task_id>.jsonl`, one self-contained event per line. The
directory is git-ignored (`.orchestration/state/`), so the log is working
state, not a committed artefact. Lines are hash-chained: every event stores in
`prev` the SHA-256 of the raw bytes of the previous line, the first event
carries `prev: null`, and `seq` counts from 0. `verifyChain` detects any later
edit, insertion or removal as a mismatch and names the line at fault. A crash
can leave at most a torn final line; `readEvents` reports that partial tail
separately and ignores it for folding and verification, while a break earlier
in the file is fatal. `appendEvent` fsyncs each line before returning.

### 4.9 The run head
<!-- status: implemented tests=tests/acceptance-a.test.js#AC1: the merged lifecycle anchors every event to the base and commits the run head -->

The event log is not committed as a file. Instead, at the `integrate` stage the
engine hands the current log head (the SHA-256 of the last line) to the VCS
adapter, which merges the task branch into the base and records that head in
the merge commit's message as the trailer `Yukl-Run-Head: <task_id> <hash>`.
`yukl status` reads the newest such trailer for the task from the base branch
and checks that the log still contains a line hashing to it. A log that is
internally consistent but no longer contains the committed head fails that
check even though its chain verifies.

### 4.10 The runtime adapter interface
<!-- status: implemented tests=tests/adapter-orca.test.js#the adapter implements the runtime interface -->

A runtime adapter implements `start`, `status`, `result` and `stop`. The
bundled adapters include `fake` (a scripted test double), `orca` (drives the
Orca CLI through argument arrays) and `vcs-git-local` (merges through local
git); `vcs-github` merges through the GitHub CLI, and each adapter file has its
own test suite. The bundled Orca adapter's handle, result and base-branch
shapes are specified in section 4.16.

### 4.11 The lifecycle directory stays adapter-neutral
<!-- status: implemented tests=tests/runtime-neutrality.test.js#the lifecycle directory is runtime-neutral -->

The lifecycle directory imports no adapter directly, so it stays free of any
single agent's vocabulary and of hard imports of a particular adapter.

### 4.12 The lifecycle block
<!-- status: implemented tests=tests/command-run.test.js#lifecycleViolations rejects an adapter with no file and a stateDir outside the root -->

The `lifecycle` block of `yukl.config.json` names the adapter and agent for each
agent stage and the VCS adapter for `integrate`. The build validates that every
named adapter has a matching file under `scripts/adapters/` and that the state
directory resolves inside the repository; `yukl run` reads the same checks back
through `lifecycleViolations`.

### 4.13 The scheduler
<!-- status: implemented tests=tests/command-schedule.test.js#schedule runs a wave concurrently and starts the next wave only after it settles -->

`yukl schedule <task_id>... [--cwd <dir>] [--base <git-ref>]
[--locks-dir <dir>] [--worktrees-dir <dir>] [--json]` drives several tasks
unattended at once. Each task runs `yukl run <task_id> --unattended` in its own
Git worktree under `.orchestration/worktrees/<task_id>` (created detached from
the base ref, reused when it already exists), so two tasks never share a
checkout. Two tasks may run at the same time only when their intents'
`allowed_paths` cannot overlap: the planner compares the directory prefix of
each pattern (`scripts/**` and `scripts/*.js` both scope `scripts`), treats a
pattern that contains another as overlapping, and packs the tasks into waves in
the order given, so a task joins the first wave it fits and a wave runs
concurrently while the next one waits. A task whose intent is missing or
malformed has an unknown scope and overlaps everything, which serialises it
rather than letting it race. Each task takes its id as an advisory lock
(section 4.14) before its worktree is prepared and releases it afterwards, and a
task whose lock is held by a live owner is reported and skipped instead of run.
The exit code is 0 when every task exited 0 and 1 when any failed or was
refused. There is no queue file and no daemon: the positional task ids are the
whole input, so a scheduled run is as reproducible as the shell history that
started it.

With `--base`, each task's intent is read from that ref through `git show`,
exactly as `yukl run --base` reads its `lifecycle` block and its policy, so a
task branch cannot widen the `allowed_paths` its own scheduling is planned from
- an intent edited only in the working tree is ignored. Without `--base` the
working tree is read, which makes local mode a developer preview rather than a
trust boundary: the scheduler then plans the waves from whatever the checkout
says. `--base` is also passed on to every task's `yukl run`, so the same ref
governs what each task is allowed to do once it starts.

### 4.14 The advisory lock broker
<!-- status: implemented tests=tests/lifecycle-locks.test.js#a lock whose owner process is gone is reclaimed, not respected -->

`scripts/lifecycle/locks.js` guards a shared resource - a dependency install, a
task's worktree, a branch - with one file per lock at
`.orchestration/locks/<name>.lock`. The exclusive create of that file is the
mutual exclusion (`writeFileSync` with the `wx` flag fails with `EEXIST` when
someone else holds it), so the broker needs no lock manager and no second state
store. The file records its owner as JSON: `{ name, pid, host, task, at }`.
`yukl lock hold <name> [--task <id>] -- <command>` acquires the lock, runs the
command while holding it, and releases it in a `finally`, so a failed or killed
command still releases; `yukl lock status <name>` and `yukl lock release <name>`
inspect and clean up, and a release names the process id it releases so a
stranger cannot remove a live owner's lock without `--force`. When the recorded
process is gone - the owner crashed or was killed - a later acquirer reclaims
the lock instead of blocking forever, and the dead owner is reported. Nothing is
taken on trust beyond that: a lock file that cannot be parsed is refused rather
than reclaimed, because guessing would hand out a lock another process may still
hold. The clock, the process id, the host and the liveness check are injectable,
so the behaviour is tested without a real process, a real clock or a real crash.

Reclaiming is not atomic with the inspection that found the owner dead, so it
goes through a second lock file, `<name>.lock.reclaim`, taken exclusively by the
one acquirer that may remove the stale lock. Two acquirers that both see the
same dead owner therefore cannot both remove: the loser is refused with the lock
reported held, and if it waits it re-inspects the winner's fresh lock and finds
it live. The guard holder re-reads the lock under the guard and removes it only
while it still names the same dead owner, so a lock that changed hands since the
inspection is left alone rather than deleted; a lock that cannot be re-read as
the same record is never removed. The guard records its own owner like any lock,
so a reclaimer that crashed mid-reclaim leaves a stale guard that the next
acquirer reclaims in turn rather than a permanent wedge.

### 4.15 Working-copy publication: `yukl vcs-sync`
<!-- status: implemented tests=tests/command-vcs-sync.test.js#syncJjWorkingCopy publishes an undescribed working copy and points the Git branch at it -->

`yukl vcs-sync [--cwd <dir>] [--bookmark <name>] [--json]` publishes the
working copy of a colocated Jujutsu workspace (`@`) as the Git branch `yukl-wc`,
or as `--bookmark <name>`. The gap it closes is Orca's: a worker's worktree is
branched from a Git ref, and work that lives only in `@` - Jujutsu snapshots the
working copy on every command, so most of it is never committed by hand - is
invisible to a worker branched from the branch tip, which silently misses it.
`yukl run` calls the same function (`syncJjWorkingCopy`) immediately before
every agent start it makes (section 4.2), so the sync is a dispatcher hook
rather than a step someone has to remember, and a long run that dispatches
several stages republishes the state as it is at each dispatch.

The sync moves a bookmark and exports it and never edits `@`: an undescribed
working-copy commit is exported exactly as it is - Jujutsu's own `jj git push`
still refuses to publish such a commit - a description its author wrote is left
byte-for-byte alone, and files Jujutsu ignores (`node_modules`, `.env`) are not
part of the snapshot. It reads `@` once, sets the bookmark to it with
`--allow-backwards`, exports through `jj git export`, and then asks Git to
resolve `refs/heads/<bookmark>` to that commit: the ref counts as published only
when Git confirms it, so a sync that cannot be proven does not pass as one.

Which bookmarks may move is decided before anything is written. `yukl-wc` is the
harness's own namespace, so it is movable whether Git already names the previous
published `@` or names no such ref yet. Any other bookmark moves only when it
already points at `@`, where the sync merely republishes what Git is missing;
everything else is a ref the user owns, and it is refused instead of rewritten.

It fails closed - exit 1, nothing published, and the dispatch it guards is
refused - rather than publishing a state it cannot vouch for:

- **A workspace that cannot be read.** A `.jj` entry at or above the working
  directory (the walk stops at the filesystem root) means a workspace is
  unmistakably there, so jj missing, or `jj root` exiting non-zero, is an error
  naming the directory that holds `.jj` and jj's first stderr line; only a tree
  with no `.jj` anywhere is treated as not a Jujutsu workspace at all. A
  Jujutsu-only repository (`.jj` without `.git`) is refused with the
  `jj git colocation enable` message that `yukl verify` also uses.
- **A bookmark jj will not vouch for.** A conflicted bookmark, a bookmark that
  names no single commit, a row the sync cannot read, a name jj reports more
  than once, and a `jj bookmark list` that fails outright are all refused.
  Reading an unresolved conflict as "missing" is what would let
  `--allow-backwards` overwrite it with `@`.
- **A bookmark that tracks a remote.** Moving it would rewrite a ref other
  people already see, so it is refused - and so is a jj that cannot answer the
  question, because assuming "no remote" is how a published ref gets rewritten.
  The default `yukl-wc` is refused on that ground too.
- **A custom bookmark that does not already point at `@`.** It is refused with
  the working-copy commit id, since `--allow-backwards` would otherwise drag a
  real branch onto the working copy.
- **Git that cannot confirm the export.** When `refs/heads/<bookmark>` does not
  resolve to the commit jj exported, the sync reports that the working copy was
  not published.

A plain Git repository is not a mistake: with no Jujutsu workspace anywhere the
command exits 0, reports "no Jujutsu workspace" and publishes nothing. Exit 1
means a Jujutsu workspace could not be published, and exit 2 is a usage problem
(an unknown flag, a missing value, a stray positional, or a `--bookmark` that is
not Git-branch-shaped, all refused before jj is spawned). `--json` prints the
result object on one line instead of the human summary, so a calling hook can
read it.

### 4.16 The Orca adapter: handle, result and base branch
<!-- status: implemented tests=tests/engine-orca.test.js#yukl run --once drives a real-adapter start to an advanced stage -->

The bundled Orca adapter is the runtime that the engine drives through the
interface of section 4.10, and three of its shapes are load-bearing.

**The handle is the dispatch id string.** `start` returns the Orca dispatch id
itself - a non-empty string - and `status`, `result` and `stop` accept that
string back. The engine normalises a start's return value through `handleId`
(section 4.1), which accepts a string or `{ id }` and refuses everything else,
then records the id in `stage_started.data.handle` and hands it back on every
poll. The shipped `{ dispatchId }` object was refused by that check after Orca
had already started a worker, so the run could never advance; the bare id is
the shape that survives the round trip. A value that is not a non-empty string
is a foreign handle - one this adapter never produced - and is answered without
calling Orca at all: `status` reports `unverifiable`, `result` returns null and
`stop` does nothing. Returning the outcome word from `result` was the same
class of mistake: the engine reads `result.exitCode`, so `result` returns
`{ exitCode: 0 }` for a `succeeded` projection and `{ exitCode: 1 }` for
`failed`, and null while the projection is unsettled. A null result from an
`exited` worker is treated as a refusal, not a success.

`--base-branch` is emitted only when a base is known. `null`, `undefined` and
`""` all omit the flag pair entirely, so Orca falls back to the repository's
default base through its documented omission ("omit `--base-branch` to use the
repo default base") rather than through an empty value. Experiment E6 (Orca
1.4.210, 2026-09-25) found that `--base-branch ""` is accepted and also falls
back to the default - the worktree was created from `refs/remotes/origin/main` -
but that empty-string behaviour is undocumented, so the adapter does not depend
on it.

The regression guard is an integration test over the real composition root:
`yukl run --once` in a temporary repository whose lifecycle block routes
`implement` to the Orca adapter and the fake CLI starts exactly one worker,
records the dispatch id as the handle, and then advances `implement -> prove`
once `worker-show` reports the worker exited with a `succeeded` outcome.
Restoring the shipped `{ dispatchId }` return makes that test fail with
`runtime.start must return a non-empty string handle id`.

### 4.17 Known limits
<!-- status: background -->

Four limits bound what the machinery above can prove, and they are worth
stating plainly.

1. **The human and the agent share one GitHub identity.** The harness records
   who acted in an event, but it cannot prove cryptographically that a
   `decide` or a merge came from a person rather than an agent using the same
   account. The `YUKL_DISPATCH_ID` guard and the event log are audit trails,
   not identity proofs.
2. **The `YUKL_DISPATCH_ID` guard does not reach Orca workers.** `yukl decide`
   refuses when `YUKL_DISPATCH_ID` is set, and an adapter that spawns the agent
   process directly can set it. Orca's `worker-start` cannot set the
   environment of the worker it launches, so the Orca adapter cannot forward
   the variable (documented in `scripts/adapters/orca.js`). A worker launched
   through Orca is therefore not fenced off from `yukl decide` by that guard.
3. **The uncommitted tail is covered by no committed head.** Events appended
   after the merge that carries the run-head trailer are real recorded state,
   but no committed head vouches for them. `yukl status` reports their count as
   the uncommitted tail rather than claiming they are verified; an agent with
   write access to the state directory can append events that extend the chain
   without any committed head contradicting them.
4. **Reclaiming a stale reclaim guard is not serialised.** The broker's
   stale-lock reclaim runs under an exclusive `<name>.lock.reclaim` guard
   (section 4.14), but taking that guard when it is itself stale - a reclaimer
   that crashed mid-reclaim - is not guarded in turn. Two acquirers that
   collide on such a guard can in principle both take it, both remove the stale
   lock, and one of them delete the lock the other has just created. The
   same-owner re-check each performs narrows the window to the interval between
   its re-read of the lock and its removal; it does not close it. The module
   header of `scripts/lifecycle/locks.js` states the same residual limitation.
