# Architectural Audit Report: Yukl-OS Power Harness

**Auditor:** Independent Architectural Review (Dispatched Worker)
**Date:** 2026-09-22
**Verdict:** FAIL - Significant structural, theoretical, and standards gaps

---

## 1. Summary Verdict

The Yukl-OS harness is an ambitious attempt to map organisational psychology onto agentic SDLC constraints. The core idea - partitioning cognitive load across specialised agents with power-based governance - has merit. However, the implementation suffers from: incomplete Yukl taxonomy coverage (5 of 11 bases represented), phantom file references, contradictory role assignments across documents, an unenforceable "150-instruction budget" claim with no measurement mechanism, missing GitHub community health files, and a pipeline configuration that cannot actually enforce its own stated guarantees. The harness is a well-written essay masquerading as executable architecture.

---

## 2. Instruction Budget Analysis

### Claim vs Reality

CLAUDE.md claims a "mathematically limited" cognitive instruction budget. `YUKL_ARCHITECTURE.md` specifies "150-200 concurrent instructions" as the collapse threshold, and Section 2.1 restricts the root file to "< 60 lines."

**Findings:**

| File | Lines | Approx. Instructions |
|---|---|---|
| CLAUDE.md | 27 | ~15 directives |
| drafter-api.md | 17 | ~8 directives |
| auditor.md | 17 | ~8 directives |
| independent-auditor.md | 10 | ~4 directives |
| plan-drafter.md | 9 | ~3 directives |

- **F2.1:** No file approaches the 150-instruction limit. The "budget" framing implies scarcity that does not exist. The total across all rule files is approximately 38 directives - well under any reasonable dilution threshold.
- **F2.2:** "Mathematically limited" is stated but no measurement function, linter, or CI check enforces it. There is no tool that counts instructions or blocks a commit when a file exceeds the budget.
- **F2.3:** The 60-line claim for CLAUDE.md (Section 2.1 of YUKL_ARCHITECTURE.md) is met (27 lines), but this is accidental, not enforced.
- **F2.4:** `flow.config.json` embeds multi-sentence `spec` strings containing 4-6 directives each. These are invisible to any line-count heuristic and effectively smuggle instructions outside the "budget" system.

---

## 3. 12-Factor Agents Compliance

Evaluated against Dex Horthy's 12-Factor Agents framework (2024).

| Factor | Status | Notes |
|---|---|---|
| 1. Natural language as the universal interface | PARTIAL | Specs are natural language but mixed with JSON config |
| 2. Put the agent in charge of its own context | FAIL | Context is imposed top-down; agents cannot request additional context |
| 3. Tools are just structured I/O | PARTIAL | Contract JSON is structured but tool definitions are absent |
| 4. Unify execution and planning | FAIL | Drafter and Auditor are hard-separated; no agent can plan AND execute adaptively |
| 5. Compact errors into context, don't break the loop | FAIL | `onFailGoto` restarts the entire step; no error context is carried forward |
| 6. Own your control flow | FAIL | Control flow is owned by the pipeline, not by agents. Agents are passive executors |
| 7. Contact humans through tools, not pauses | PARTIAL | `interactive: true` and `gate: true` exist but are ad-hoc, not tool-based |
| 8. Own your auth | NOT ADDRESSED | No authentication model exists |
| 9. Embed in existing developer workflows | PARTIAL | Uses npm/jj but no CI/CD integration, no GitHub Actions, no PR automation despite claiming it in Phase 5 |
| 10. Test like software | FAIL | No test suite for the harness itself; `npm run test` references a non-existent test runner |
| 11. Deploy progressively | NOT ADDRESSED | No deployment model |
| 12. Log and trace everything | FAIL | No observability. `.orchestration/artifacts` is referenced but no logging format, no trace IDs, no audit trail mechanism |

**Overall: 0 PASS, 4 PARTIAL, 6 FAIL, 2 NOT ADDRESSED.**

---

## 4. Yukl Power Taxonomy Audit

Gary Yukl's taxonomy identifies 11 proactive influence tactics (not "bases of power" as the docs conflate). The harness also mislabels several.

### Tactics Represented

| Yukl Tactic | Claimed Location | Assessment |
|---|---|---|
| Legitimate Power | CLAUDE.md, pipeline stage 1 | Correctly applied as positional authority |
| Expert Power | drafter-api.md, plan-drafter.md | Correctly applied as specialist knowledge |
| Coercive Power | auditor.md, pipeline stage 3, CLAUDE.md | Correctly applied as punishment/rejection |
| Rational Persuasion | Contract system | Correctly applied as evidence-based influence |
| Consultation | .yukl-intent.yml `consultation` block | Correctly applied as participative decision-making |
| Information Power | CLAUDE.md Section 2, progressive disclosure | Correctly applied as control of information flow |
| Referent Power | auditor.md | Claimed but misapplied - referent power is influence through admiration/identification, not code review authority |
| Ecological Power | SDLC_PLAN.md Phase 1 | Non-standard term. Yukl does not use "Ecological Power." Appears to mean environmental/structural control |

### Tactics Missing (Critical Gaps)

| Yukl Tactic | Status |
|---|---|
| Reward Power | ABSENT - no positive reinforcement mechanism (e.g., agent priority boost, token budget increase for good work) |
| Inspirational Appeals | ABSENT - no mechanism for motivating agents toward a vision |
| Personal Appeals | ABSENT - not applicable to agents (acknowledged) |
| Exchange | ABSENT - no quid pro quo between agents |
| Coalition Tactics | ABSENT - no multi-agent voting or consensus mechanism |
| Ingratiation | ABSENT - not applicable to agents (acknowledged) |
| Legitimating Tactics | ABSENT - distinct from Legitimate Power; no mechanism for agents to justify requests by citing rules |
| Pressure | ABSENT - distinct from Coercive Power; no escalating urgency mechanism |

**F4.1:** The docs conflate "bases of power" (French & Raven, 1959) with "influence tactics" (Yukl & Falbe, 1990). These are distinct frameworks. The architecture doc title says "Yukl's Taxonomy of Power" but the content mixes both without acknowledging the distinction.

**F4.2:** "Ecological Power" (SDLC_PLAN.md) is not a Yukl term. It appears to be invented. The closest Yukl concept would be "situational control" or structural influence through environment design.

**F4.3:** Referent Power is misattributed. The auditor.md says the Auditor has Referent Power as "establishing the standard of excellence." Referent Power in Yukl is charisma-based identification - wanting to be like the power-holder. What is described is actually Expert Power or Legitimate Power.

**F4.4:** The README claims "all 12 bases" but Yukl's taxonomy has 11 influence tactics and French & Raven's has 6 (later 7) bases. Neither framework has 12.

---

## 5. Internal Consistency Failures

| ID | Severity | Finding |
|---|---|---|
| IC-1 | CRITICAL | `CLAUDE.md` references `.claude/rules/drafter-ui.md` but this file does not exist. Any agent touching `src/ui/**` gets no rules injected. |
| IC-2 | HIGH | `CLAUDE.md` says to use Jujutsu (`jj`) worktrees. `SDLC_PLAN.md` Phase 1 says to use "native Git worktrees." `orca.yaml` says `sandbox: "local-worktree"` without specifying which VCS. Three files, three different isolation models. |
| IC-3 | HIGH | `CLAUDE.md` references `.orchestration/contracts/current_task.json` (singular filename). `YUKL_ARCHITECTURE.md` references `.orchestration/contracts/<task_id>.json` (parameterised). `flow.config.json` stage 2 writes `CONTRACT.json` (different name). Three different contract file conventions. |
| IC-4 | HIGH | `auditor.md` path scope covers `".orchestration/contracts/*.json"` AND `"src/**"` - but the auditor is "strictly forbidden from writing product code." Granting write access to `src/**` contradicts this. (Path-scoped rules grant both read and write access in Claude's rule system.) |
| IC-5 | MEDIUM | `flow.config.json` stage 3 sets `"gate": false` for the Auditor. But README Section 6 says `gate: true` enforces "strict Consultation." The Auditor stage has no human gate. |
| IC-6 | MEDIUM | `CLAUDE.md` Section 4 lists `npm run build`, `npm run test`, `npx @biomejs/biome format`. No `package.json` exists in the repository. These commands will all fail. |
| IC-7 | MEDIUM | `flow.config.json` stage 2 uses `"agent": "opencode"` but all docs describe the Drafter as using `jj` worktrees. OpenCode (Sourcegraph's agent) has no native `jj` integration. |
| IC-8 | LOW | `independent-auditor.md` says to audit `docs/SDLC_PLAN.md` specifically. `auditor.md` says to read `.orchestration/contracts/current_task.json`. These are two different auditor roles with different scopes but no clear delineation of when each applies. |
| IC-9 | LOW | `orca.yaml` is 4 lines with no pipeline, agent, or task configuration. It declares `version: "1.0"` and `sandbox: "local-worktree"` but provides no actionable configuration for Orca to consume. |
| IC-10 | LOW | `.yukl-intent.yml` contains placeholder text ("Assumption 1...", "Briefly describe..."). It is a template, not a populated intent. If the pipeline reads this file as-is, the Auditor would be verifying placeholder commands. |

---

## 6. GitHub Standards Gaps

Evaluated against GitHub's 2026 open-source community health standards.

| Standard | Status |
|---|---|
| README.md | EXISTS - but no badges, no install instructions beyond "copy a file", no API docs |
| LICENSE | MISSING - repository has no licence file. Legally, this means "all rights reserved" by default |
| CONTRIBUTING.md | MISSING |
| CODE_OF_CONDUCT.md | MISSING |
| SECURITY.md | MISSING - critical for a framework that claims security governance |
| .github/ISSUE_TEMPLATE/ | MISSING |
| .github/PULL_REQUEST_TEMPLATE.md | MISSING |
| .github/FUNDING.yml | MISSING |
| .github/workflows/ (CI) | MISSING - no GitHub Actions despite SDLC_PLAN.md Phase 5 describing a GitHub Action |
| .gitignore | MISSING - `.orchestration/` artifacts, `node_modules/`, lock files will be committed |
| package.json | MISSING - `npm run build` and `npm run test` in CLAUDE.md will fail |
| CHANGELOG.md | MISSING |

---

## 7. Prioritised Architectural Failures

Ranked by severity and blast radius.

| Priority | ID | Title | Impact |
|---|---|---|---|
| P0 | AF-1 | **No executable runtime.** No package.json, no test runner, no build step. Every `npm` command in CLAUDE.md fails. The harness is documentation without a runnable system. | Complete |
| P0 | AF-2 | **Phantom file references.** `drafter-ui.md` does not exist. Agents touching UI code operate without constraints. `.orchestration/` directory does not exist. Contract writes fail. | Complete |
| P0 | AF-3 | **No licence.** Legally unpublishable as open-source. | Legal |
| P1 | AF-4 | **Unenforced instruction budget.** The central thesis (cognitive dilution at 150 instructions) has no measurement or enforcement mechanism. It is an unfalsifiable claim. | Credibility |
| P1 | AF-5 | **Conflated power taxonomy.** Mixes French & Raven's bases with Yukl's tactics, invents "Ecological Power," misapplies Referent Power, claims "12 bases" when neither framework has 12. | Credibility |
| P1 | AF-6 | **Three-way VCS conflict.** jj vs Git worktrees vs unspecified. Pick one and enforce it. | Architectural |
| P1 | AF-7 | **Contract filename inconsistency.** `current_task.json` vs `<task_id>.json` vs `CONTRACT.json`. Agents will write to the wrong path. | Functional |
| P2 | AF-8 | **12-Factor Agents: 0 full passes.** The harness claims alignment with Horthy's framework but violates most factors, particularly agent context ownership and error compaction. | Design |
| P2 | AF-9 | **No observability.** No logging, no trace IDs, no artifact retention policy. Debugging a failed pipeline is guesswork. | Operational |
| P2 | AF-10 | **Auditor has src/** write scope.** Path-scoped rules grant mutation access to the agent that must not write code. | Security |
| P3 | AF-11 | **orca.yaml is a stub.** 4 lines, no actionable configuration. | Completeness |
| P3 | AF-12 | **SDLC_PLAN.md Phase 5 is vapourware.** Describes a GitHub Action feedback loop that does not exist and has no implementation path. | Completeness |
