# Pull Request

## Summary

What does this change do, and why?

Closes #

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change
- [ ] Documentation only
- [ ] Tooling / CI

## Scope of files touched

List the files changed. Confirm the change is limited to the issue scope; flag
anything adjacent you deliberately left alone.

## Rational Persuasion: empirical proof

Every pull request must prove its own correctness.

- Command run: `...`
- Expected exit code: `0`
- Observed exit code: `...`
- Test output / log excerpt:

```text
<paste here>
```

## Checklist

- [ ] `npm run test` passes (includes the instruction-budget check).
- [ ] `npm run build` passes.
- [ ] `npm run format` applied.
- [ ] Contract filenames use `.orchestration/contracts/<task_id>.json`.
- [ ] French & Raven bases and Yukl tactics are not conflated.
- [ ] I have not approved my own work; an independent review is required.
