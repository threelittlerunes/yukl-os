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
The root `CLAUDE.md` is the system's constitution. It is restricted to **fewer than 60 lines** and is checked by `scripts/count-instructions.js`. It must pass the *Discoverability Test*: if an agent can infer a rule by reading the code, the rule is excluded. The root file states the agent's Legitimate Power, acting purely as a router that points agents to their specialized scopes.

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
