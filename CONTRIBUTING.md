# Contributing to Yukl-OS

Thanks for helping govern agents rather than plead with them. This repository is
itself a harness, so contributions are held to the standard the harness claims to
enforce: small scope, empirical proof, no vibes.

## Getting set up

```sh
git clone https://github.com/YOUR-USERNAME/yukl-os
cd yukl-os
npm install
npm run build   # static validation of the harness configuration
npm run test    # instruction-budget check + the test suite
```

Node 20 or newer is required. There is no runtime build step: `build` validates
the harness configuration, `test` runs the suite via the built-in
`node --test` runner.

## The contribution contract (Rational Persuasion)

Every pull request must carry empirical proof:

1. State the exact command you ran to verify the change.
2. State the expected exit code. It must be `0`.
3. List the files you touched.

`npm run test` must pass. If your change touches a path-scoped rule, the
instruction-budget check (`node scripts/count-instructions.js`) must still pass;
if it does not, trim the rule rather than raising the budget silently.

## Contracts and the verify gate

Proof files are committed. Every task writes its empirical proof to
`.orchestration/contracts/<task_id>.json`, and that file is part of the pull
request. CI runs a `verify-contract` job (`node scripts/yukl.js verify --base
origin/main` on pull requests). The job is designed to be the merge gate and
blocks merges once it is configured as a required status check on the default
branch: enable GitHub branch protection and require the check named "Verify
contracts (Rational Persuasion gate)", and merges are blocked unless every
changed file is covered by a committed contract and every proof command is
allowlisted.

Commands are allowlisted. `yukl verify` never executes a command that is not an
exact entry in `rational_persuasion.empirical_proof` in `.yukl-intent.yml`.
With `--base`, the allowlist is read from the base branch, so a pull request
cannot widen its own allowlist. The allowlist limits which proof commands a
contract may claim; it is not a sandbox - allowlisted commands such as
`npm run test` execute the pull request's own code, as the existing `validate`
job already does.

For an early warning before you push, run the gate locally:

```sh
npm run verify -- --base origin/main
```

This is a preview only and it checks committed state only (base...HEAD):
uncommitted or untracked changes are invisible to it, and it prints a warning
when the working tree is dirty. Commit first for an accurate preview. The CI
job is designed to be the merge gate and blocks merges once it is configured as
a required status check on the default branch.

## Changing the harness

- **Rules** live in `.claude/rules/`. Every rule file needs YAML frontmatter with
  a non-empty `paths` array. Keep each file inside its instruction budget.
- **Pipeline** lives in `flow.config.json`. Contracts are always written to
  `.orchestration/contracts/<task_id>.json`; do not introduce another filename.
- **Isolation** is Git worktrees, always. Do not reintroduce a second VCS.
- **Taxonomy**: French & Raven's bases of power and Yukl's influence tactics are
  distinct frameworks. Keep them separate in prose and in code.

## Deterministic-first validation

Every new validation check must prove itself before it ships:

- **Fault injection:** demonstrate the check catches the defect by running it
  against a deliberately broken fixture and showing a non-zero result.
- **Gap evidence:** show the defect class was previously left to LLM review -
  that is, no structural check existed before yours.
- **Right home:** structural checks belong in `npm run build` or `npm run test`,
  not in ad-hoc LLM audit passes. If a check cannot run deterministically, it
  does not go into the harness.

## Pull request process

1. Fork the repository and create a topic branch.
2. Make the smallest change that resolves the issue.
3. Run `npm run format` and `npm run test`.
4. Open a pull request using the template and fill in the proof section.
5. The change is merged only after an independent review. The author never
   approves their own work.

## Reporting bugs and requesting features

Use the issue templates under `.github/ISSUE_TEMPLATE/`. For vulnerabilities, do
**not** open a public issue - follow `SECURITY.md`.

## Code of conduct

Participation is governed by `CODE_OF_CONDUCT.md`.
