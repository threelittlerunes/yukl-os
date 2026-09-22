# Intent: pilot-b1-baseline (pathfinder)

**Objective:** Get pathfinder's baseline green before the harness is installed: fix the one failing test and the 18 ruff errors, without loosening any check.

**Repo:** `threelittlerunes/pathfinder`, local at `C:\Users\kjeld\orca\projects\reverse-engineering` (the folder has not been renamed yet). It is a colocated Jujutsu repo, and the Python project lives in `app/`.

**Gate:** the harness is not installed yet (that is B2), so there is no `yukl verify`. This change touches product code, so **Kris reviews the PR** (`requires_human_approval: true`).

## Baseline (measured 2026-09-22, `app/.venv`)

- `python -m ruff check`: 18 errors. 7 are E501 (line too long), 6 F401 (unused import), 2 I001 (unsorted imports), 1 E401 (multiple imports on one line), 1 F841 (unused variable) and 1 SIM300 (Yoda condition). 10 can be fixed with `--fix`.
- `python -m pytest`: 1 failed and 368 passed. The failure is `tests/test_sweep_searches.py::TestSearchFailureIsContained::test_a_failing_search_does_not_stop_the_other_or_remove_anything` (`jobs_removed` is 3, expected 0).

## Root cause of the failing test

This is test rot, not a product bug. `tests/fixtures/jobnet/search-automatisering.json` holds real adverts with fixed `applicationDeadline` values, and three of them (18, 20 and 20 September 2026) are now in the past. `verify_availability` correctly marks query-sourced jobs removed once their deadline passes, as its docstring states, so the sweep removes those three. More adverts expire on 24 September, 27 September and later, so the other tests that use this fixture will start failing too.

## Scope

Allowed paths:

- `app/src/**` (ruff fixes only; no change in behaviour)
- `app/tests/**`

Forbidden: `app/pyproject.toml` (no new ruff ignores, no changes to line length), `app/.venv/**`, `app/frontend/**`, and everything outside `app/`.

## Acceptance criteria

1. `python -m ruff check` exits 0 in `app/`, and the ruff config is unchanged.
2. `python -m pytest` exits 0 in `app/`, and the test count is still 369.
3. The failing test is made independent of the date, either by freezing the clock or by re-basing the fixture deadlines relative to `utcnow()`. Deleting the test, loosening its assertions, or setting a deadline further out by hand is not acceptable. It must still pass when the clock is moved to 2027-06-01. Prove this with the same freeze mechanism or a monkeypatched `utcnow`.
4. The E501 fixes wrap lines. They add no `# noqa` comments.
5. `pathfinder.pipeline.verify_availability` and the rest of the product behaviour are unchanged. `git diff` under `app/src/` contains only lint changes, and the PR description says so for each file.

## Proof commands (run in `app/`)

```sh
.venv/Scripts/python -m ruff check
.venv/Scripts/python -m pytest -q
```

## Assumptions (for the Auditor to test)

- The other tests that use the same fixture pass only because their deadlines have not passed yet, so the date-independence fix should cover the whole fixture, not just the one test.
