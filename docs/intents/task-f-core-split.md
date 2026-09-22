# Intent: task-f-core-split

**Objective:** Separate the installable core (`render`, `verify`, the contract schema, the flow config) from the checks that only govern this repository (community files, the CLAUDE.md/AGENTS.md parity check, instruction budgets for these rule files), so the core runs inside any target repo.

## Scope

Allowed paths:

- `scripts/**`
- `tests/**`
- `package.json`
- `CHANGELOG.md`
- `.orchestration/contracts/task-f-core-split.json`

Forbidden: `CLAUDE.md`, `AGENTS.md`, `.claude/rules/**`, `.github/**`, `flow.config.json`, `.yukl-intent.yml`. The intent format belongs to task g.

## Acceptance criteria

1. `yukl verify` and `yukl render` resolve the repo from `process.cwd()` (or a `--cwd` flag), not the package directory. Today `scripts/yukl.js` passes `cwd: ROOT`, and `DEFAULT_FLOW_CONFIG` is also anchored to `ROOT`.
2. The core modules do not import `REQUIRED_FILES`, `SCAN_FILES`, `BUDGETS` or anything else specific to this repo. The repo-only checks move to a separate module that only this repo's `npm run build` and `npm run test` call.
3. A test creates a temporary Git repo with only a flow config, `.yukl-intent.yml` and one contract, runs `verify --base` in that repo, and gets exit 0. A known-bad control (a contract with a non-allowlisted command) exits 1.
4. This repo's `npm run build` and `npm run test` still apply every check they apply today. The count of assertions is not reduced.

## Assumptions (for the Auditor to test)

- The package can still be run in place (`node scripts/yukl.js`). Publishing to npm is Phase C.
- `js-yaml` stays the only runtime dependency.

## .yukl-intent.yml block

```yaml
intent:
  goal: "Separate the installable core from this repo's own checks."
  scope:
    allowed_paths:
      - "scripts/**"
      - "tests/**"
      - "package.json"
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
