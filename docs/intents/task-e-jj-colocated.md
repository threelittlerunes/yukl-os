# Intent: task-e-jj-colocated

**Objective:** Support Jujutsu when it is colocated with Git. Drop the AF-6 "no Jujutsu" invariant, and make `yukl verify` refuse with a clear message when a repo uses Jujutsu without Git metadata.

## Scope

Allowed paths:

- `scripts/yukl.js`
- `scripts/validate-config.js`
- `tests/yukl.test.js`
- `tests/rules.test.js`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `docs/SDLC_PLAN.md` (the `plan-drafter` rule applies, and an Independent Plan Auditor pass is required)
- `CHANGELOG.md`
- `.orchestration/contracts/task-e-jj-colocated.json`

Forbidden: everything else, including `docs/AUDIT_REPORT.md` and the historical `CHANGELOG.md` entries, which are records and stay unchanged.

## Acceptance criteria

1. The Jujutsu scan in `scripts/validate-config.js:287` and the matching test in `tests/rules.test.js:42` are removed. Their CONTRACT.json and Ecological Power checks stay.
2. The PR template no longer requires "No Jujutsu/`jj` references".
3. The line "There is one VCS in this repository: Git" in `docs/SDLC_PLAN.md` Phase 1 is rewritten to "Git is required; Jujutsu is supported when colocated".
4. `yukl verify` checks the repo root before any other check. If `.jj/` is present and `.git` is absent, it exits 1 with a message naming colocated mode (`jj git init --colocate`).
5. `.git` as a **file** (a Git worktree, which is how the harness runs agents) counts as Git present. Tests cover four cases: `.git` directory, `.git` file, `.jj` plus `.git`, and `.jj` only.

## Assumptions (for the Auditor to test)

- `verify` keeps using `git diff` and `git show`. In colocated mode those give correct results once Jujutsu has exported its commits to Git.
- A secondary Jujutsu workspace (`jj workspace add`) has no `.git`, so it is refused. That is the intended behaviour.

## .yukl-intent.yml block

```yaml
intent:
  goal: "Support colocated Jujutsu; refuse Jujutsu-only repos in yukl verify."
  scope:
    allowed_paths:
      - "scripts/yukl.js"
      - "scripts/validate-config.js"
      - "tests/yukl.test.js"
      - "tests/rules.test.js"
      - ".github/PULL_REQUEST_TEMPLATE.md"
      - "docs/SDLC_PLAN.md"
      - "CHANGELOG.md"
rational_persuasion:
  empirical_proof:
    - command: "npm run build"
      expected_exit_code: 0
    - command: "npm run test"
      expected_exit_code: 0
consultation:
  requires_human_approval: false
```
