# Intent: task-g-config-intent

**Objective:** Split the root `.yukl-intent.yml` into repo-wide settings (`yukl.config.json`: commands, folders, the proof-command allowlist) and a per-task intent (goal, allowed and forbidden paths, assumptions, consultation). `yukl verify` then enforces each task's allowed paths.

## Scope

Allowed paths:

- `scripts/**`
- `tests/**`
- `yukl.config.json` (new)
- `.yukl-intent.yml` (migrate or remove)
- `.orchestration/intents/**` (new, if chosen as the location, see open question 1)
- `package.json`, `package-lock.json` (only when a glob dependency is chosen; take the lock in `.orchestration/locks/` first)
- `CHANGELOG.md`, `docs/YUKL_ARCHITECTURE.md`
- `.orchestration/contracts/task-g-config-intent.json`

Forbidden: `CLAUDE.md`, `AGENTS.md`, `.claude/rules/**`, `.github/workflows/**`.

## Acceptance criteria

1. **Trust model (locked):** `verify --base` reads both the command allowlist (from `yukl.config.json`) and the task's intent from the **base ref** via `git show`. An intent that exists only in the PR fails with the message "intent for <task_id> not found at <base>; merge the intent first".
2. For every verified contract, each changed file it covers must match the intent's `allowed_paths` and match none of its `forbidden_paths`. Forbidden wins. Violations are listed by file.
3. The glob rules are defined and tested: `**`, `*` and literal paths. Known-bad control: `src/a.js` against `allowed: ["tests/**"]` fails. Known-good control: `tests/x/y.js` passes.
4. The contract's `files_touched` must be a subset of the files changed in the diff, and every file in the diff must be covered by a contract (the current rule, kept).
5. `npm run build` validates the `yukl.config.json` schema and every intent file.

## Open questions (for the Drafter to propose, and the Auditor to challenge)

1. Where intents live: `.orchestration/intents/<task_id>.yml`, or per-task keys in one file. The per-file option is preferred, for merge-conflict isolation.
2. Glob matching: a small in-house matcher, or a dependency such as `picomatch`. `path.matchesGlob` is still experimental on Node 20, which the `engines` field allows.
3. Migration: whether the root `.yukl-intent.yml` becomes a fallback for one release or is removed straight away.

## Bootstrapping note

This PR is verified by the **old** gate, because `verify` reads its rules from the base branch. The path enforcement it adds applies from the next PR (task h) onwards.

## .yukl-intent.yml block

```yaml
intent:
  goal: "Separate repo-wide settings from per-task intent; verify enforces allowed paths."
  scope:
    allowed_paths:
      - "scripts/**"
      - "tests/**"
      - "yukl.config.json"
      - ".yukl-intent.yml"
      - ".orchestration/intents/**"
      - "package.json"
      - "package-lock.json"
      - "CHANGELOG.md"
      - "docs/YUKL_ARCHITECTURE.md"
rational_persuasion:
  empirical_proof:
    - command: "npm run build"
      expected_exit_code: 0
    - command: "npm run test"
      expected_exit_code: 0
consultation:
  requires_human_approval: true
  human_reviewer_tags: ["gate-change"]
```
