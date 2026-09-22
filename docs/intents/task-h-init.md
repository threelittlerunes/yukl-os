# Intent: task-h-init

**Objective:** Add `yukl init`, which installs the harness into a target repo on a feature branch without overwriting anything the repo already has.

## Scope

Allowed paths:

- `scripts/**`
- `templates/**` (new: CI workflow, harness markdown section, config skeleton)
- `tests/**` (including fixture repos)
- `package.json` (the `files` field)
- `README.md`, `CHANGELOG.md`
- `.orchestration/contracts/task-h-init.json`

Forbidden: this repo's own `CLAUDE.md`, `AGENTS.md`, `.github/workflows/**`, `yukl.config.json` and intents.

## Acceptance criteria

1. Refusal: exit 1 with no writes when the target is not a Git repo (task e's `.git`-or-colocated rule applies), when HEAD is the default branch or detached, or when the working tree is dirty.
2. `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` get a section between `<!-- yukl:begin -->` and `<!-- yukl:end -->` markers. Existing content is kept byte for byte outside the markers. A second run replaces only the marked section.
3. `yukl.config.json` records the detected commands and folders: Node from `package.json` scripts, Python from `pyproject.toml` (for example `ruff check`, `pytest`). Commands it cannot detect are written as `null` with a warning, never guessed. An existing config is left alone unless `--force` is passed.
4. A CI workflow at `.github/workflows/yukl.yml` sets up Node (to run `yukl`) and, when Python is detected, Python. It runs the repo's own checks and `yukl verify --base origin/<base_ref>`.
5. `.orchestration/contracts/.gitkeep` is created.
6. Idempotency: running init twice on a fixture gives no diff after the second run.
7. Fixture tests cover a Node-only repo, a Python-only repo, a mixed repo, a repo with existing CLAUDE.md content, and each refusal case.
8. The CLI entry point works through the npm bin shim. `scripts/yukl.js` only runs `main()` when `process.argv[1]` ends in `yukl.js`, but npm runs it as `node_modules/.bin/yukl` (a symlink on Linux and a `.cmd` wrapper on Windows), so the CLI probably does nothing there. This was found in the task f audit and is untested. A test runs `yukl` through an installed `.bin` shim (from `npm pack` plus an install into a temp folder) and checks that `verify` produces output.
9. Bootstrap: `yukl init` writes `yukl.config.json` and `.orchestration/intents/`. On the first init PR, the base has neither `yukl.config.json` nor `.yukl-intent.yml`, so `verify --base` fails closed. The generated CI job checks for `yukl.config.json` at the base ref first (`git cat-file -e origin/<base_ref>:yukl.config.json`). When it is absent, the job skips `verify`, prints "bootstrap: harness not installed at base; this PR is gated by human review", and exits 0. From the next PR on, `verify` runs. Test both paths, with base lacking and having the config.

## Open questions

1. When `CLAUDE.md`, `AGENTS.md` or `GEMINI.md` does not exist: create it with only the section, or skip it and warn. The plan says "existing", which suggests skip.
2. How the target repo gets `yukl` in CI before it is published: a pinned Git URL (`npx github:threelittlerunes/yukl-os#<sha>`) or a vendored copy.

## Machine-readable intent

`.orchestration/intents/task-h-init.yml` is what `verify --base` enforces. It must be merged before the implementation PR. The block below is the pre-task-g draft, kept for the record.

```yaml
intent:
  goal: "Add yukl init: install the harness into a target repo without overwriting existing files."
  scope:
    allowed_paths:
      - "scripts/**"
      - "templates/**"
      - "tests/**"
      - "package.json"
      - "README.md"
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
