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
