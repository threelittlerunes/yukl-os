# Yukl Power Harness: Agentic SDLC Architecture

**Version:** 2.0 (Advanced Configuration)
**Foundations:** French & Raven's bases of power, Yukl's influence tactics, Dex Horthy's 12-Factor Agents, ETH Zurich context-dilution limits.

---

## 1. The Core Problem: Cognitive Dilution & Anthropomorphism
The primary failure mode of Agentic SDLCs is not capability, but **Context Dilution**. Frontier models suffer a probabilistic collapse in instruction adherence when system prompts exceed roughly 150 concurrent instructions. When a "vibecoder" stuffs testing conventions, database schemas, and architectural guidelines into a single `CLAUDE.md`, the model's attention mechanism degrades. It begins to ignore critical security constraints just as frequently as it ignores minor styling preferences.

This claim is measured, not asserted. `scripts/count-instructions.js` counts the directives injected by the root file and every path-scoped rule, and `npm test` fails when any file - or the system as a whole - exceeds its budget.

Furthermore, assigning generic, monolithic roles to agents ("Be a senior developer") fails to establish the organizational friction required for robust software engineering.

## 2. Two Frameworks: Bases of Power and Influence Tactics

The harness draws on **two distinct** organisational-psychology frameworks. They are frequently conflated, so this document keeps them separate throughout.

### 2.1 French & Raven: Bases of Power
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

| Harness mechanism | Framework | Concept |
|---|---|---|
| Root `CLAUDE.md` router | French & Raven base | Legitimate power |
| Progressive disclosure / path-scoped rules | French & Raven base | Informational power |
| Drafter (specialist implementation) | French & Raven base | Expert power |
| Auditor (independent judgement) | French & Raven base | Expert power |
| Contract verification loop | Yukl tactic | Rational persuasion |
| Mandatory human scope interview | Yukl tactic | Consultation |
| `onFailGoto` retry and process kill | French & Raven base | Coercive power |
| Situational control (isolated environment) | Structural design | Environment shapes behaviour |

Two deliberate non-mappings are worth recording. **Referent power** - influence through admiration or identification - is a human social mechanism with no meaningful agent equivalent; the harness does not claim it. **Reward power** is listed as a known gap in section 3.2.

### 2.4 Legitimate Power (The 60-Line Root Imperative)
*Authority through hierarchical position.*
The root `CLAUDE.md` is the system's constitution. It is restricted to **no more than 60 lines** and is checked by `scripts/count-instructions.js`. It must pass the *Discoverability Test*: if an agent can infer a rule by reading the code, the rule is excluded. The root file states the agent's Legitimate Power, acting purely as a router that points agents to their specialized scopes.

### 2.5 Information Power (Progressive Disclosure)
*Control over critical data flow.*
To respect the instruction limit, we weaponize Information Power. Context is aggressively withheld from agents until necessary, using **path-scoped rule files** (`.claude/rules/*.md` with YAML frontmatter).
- If an agent touches `src/api/**`, it is granted `.claude/rules/drafter-api.md`.
- If it touches `src/ui/**`, it is denied the API rules and granted `.claude/rules/drafter-ui.md`.

This ensures the instruction budget is spent exclusively on the immediate task.

### 2.6 Expert Power (Role-Based Partitioning)
*Influence through specialized knowledge.*
We abandon the monolithic generalist agent and partition execution across isolated **Git worktrees** using specialized agents.
- **The Executive Orchestrator:** Holds Legitimate Power. Manages `flow.config.json` and delegates tasks. Never writes code.
- **The Drafter:** Holds Expert Power. Operates in an isolated Git worktree. Its system prompt is aligned purely for deep implementation.
- **The Auditor:** Holds Expert Power (independent specialist judgement) plus Coercive Power. Its instruction budget is spent entirely on verification.

### 2.7 Rational Persuasion (The Empirical Contract)
*Influence through logical argument and evidence.*
An agent cannot complete a task via "vibes." It must exercise **Rational Persuasion**. Before the Drafter can request an audit, it must generate a deterministic payload at `.orchestration/contracts/<task_id>.json` containing empirical proof of success:
- Exact `curl` commands and expected HTTP codes.
- Test-runner output hashes.
- AST compilation logs.

The Auditor ingests this contract and verifies the claims autonomously.

### 2.8 Coercive Power (Tandem State Broker & Kill-Switches)
*Influence through the ability to punish or restrict.*
Because parallel agents operating in isolated worktrees will eventually encounter race conditions (for example both running `npm install`), the system uses an advisory **lock broker**. Agents acquire ephemeral `.lock` files in `.orchestration/locks/` before mutating shared resources.

If an agent hallucinates a non-existent API, violates its path-scope, or fails the Auditor's contract check, the Orchestrator exercises Coercive Power: the process is killed, the Git worktree is removed (`git worktree remove`), and the loop restarts with a penalization prompt.

---

## 3. Implementation Blueprint

By adopting this architecture, your repository becomes a self-regulating organization. You no longer prompt the AI; you govern the pipeline. See the accompanying `CLAUDE.md` and `.claude/rules/` directory for the optimized implementation of this framework.

### 3.1 12-Factor Agents: gaps and planned remediations (AF-8)

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

- **Reward power** has no mechanism. There is no positive-reinforcement signal (priority boost, larger token budget) for good work. Planned: a stage-level score that raises the Drafter's retry budget after clean audits.
- **Coalition tactics** have no mechanism. There is no multi-agent vote. Planned only if a second reviewer role is introduced.
- **Log retention** is documented but not yet enforced by a scheduled purge.

### 3.3 Dual-pipeline review mode

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
