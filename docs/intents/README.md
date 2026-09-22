# Task intents: Phase A (make the harness installable)

Output of the `legitimate-power-router` stage, from the scope interview on 2026-09-22. There is one file per task, and each task gets one PR through `yukl verify`.

| Order | Task id | Intent | Depends on |
|---|---|---|---|
| 1 | `task-e-jj-colocated` | [Support colocated Jujutsu](task-e-jj-colocated.md) | - |
| 2 | `task-f-core-split` | [Separate the core from this repo's own checks](task-f-core-split.md) | e |
| 3 | `task-g-config-intent` | [Repo-wide config and per-task intent, with paths enforced](task-g-config-intent.md) | f |
| 4 | `task-h-init` | [`yukl init`](task-h-init.md) | f, g |

## Decisions locked in the interview

1. **Split:** the plan's A1 is split into a core-only change (f) and `yukl init` (h), with A2 (g) between them, so init writes the final config format.
2. **Location:** intents are drafted here, where changes are docs-only and need no contract. Until task g lands, the intent file itself is the Drafter's scope contract, given in the dispatch spec. Copying the `.yukl-intent.yml` block or writing `.orchestration/artifacts/scope_contract.md` was dropped at task e: `verify` reads only the command allowlist, and reads it from the base branch, and neither file is in any task's allowed paths.
3. **Trust model for task g:** `verify` reads a task's `allowed_paths` from the **base branch**, the same way it reads the command allowlist today. A task's intent must be merged before its implementation PR, so an agent cannot widen its own scope.

## Dispatch

```sh
node scripts/yukl.js render expert-power-drafter --task-id <task_id>
```

Mutations go to `--agent opencode` and QA to `--agent antigravity`.
