# Intent

**Task id:** `v3-unattended`

**Objective:**
Implement Phase 3 (Autonomous Orchestration). Extend the v2 runtime so tasks run unattended and, where their scopes allow, in parallel:
1. `yukl run <task_id> --unattended` keeps driving one task until it is terminal, needs a human, escalates, or breaches a run limit. It waits for running stages instead of stopping at the 64-step cap.
2. A scheduler drives several tasks unattended at once. Each task runs in its own Git worktree. Tasks whose `allowed_paths` do not overlap run in parallel; overlapping tasks are serialised.
3. A minimal advisory lock broker for `.orchestration/locks/`: exclusive-create lock files that record their owner, release on exit, and reclaim stale locks whose owner is gone.

**Run limits (replaces "budgets"):**
- Remove `maxTokensPerRun` everywhere (policy, validator, `run.js`, tests, docs). No adapter can measure tokens, so it must not exist as a setting.
- Keep `maxWallMinutesPerRun` and `maxAgentStartsPerRun`, described as run limits. They are enforced: a breach appends an `enforcement` event to the task's event log and stops the run.
- The committed `yukl.policy.json` ships them on: `maxWallMinutesPerRun: 120`, `maxAgentStartsPerRun: 12`. Any `yukl init` template that writes a policy ships the same defaults.
- A `null` limit still means `--unattended` is refused before any adapter starts.

**Constraints:**
- The loop and the scheduler must use the existing event log, stage machine, engine and adapters; no parallel state store.
- Time and process IDs must be injectable so the tests are deterministic (no real sleeps, no real Orca calls; use the fake adapter).
- Allowed paths: `scripts/**`, `tests/**`, `templates/**`, `yukl.policy.json`, `docs/YUKL_ARCHITECTURE.md`, `README.md`, `CHANGELOG.md`, `.orchestration/contracts/v3-unattended.json`. Do not touch `yukl.config.json`, `orca.yaml`, `flow.config.json` or `INTENT.md`.
- Doc status markers must match what the tests prove (the doc-status validator runs in `npm run test`).
- The task is not complete until `.orchestration/contracts/v3-unattended.json` lists `npm run build` and `npm run test` with expected exit code `0`, lists every file touched, and `node scripts/yukl.js verify .orchestration/contracts/v3-unattended.json` exits 0.
