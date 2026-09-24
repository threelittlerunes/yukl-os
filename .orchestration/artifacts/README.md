# Orchestration Artifacts: Logging, Tracing and Retention

AF-9: `.orchestration/artifacts/` is the append-only observability sink for the
harness. It answers "what did the agent do, and why did it fail?" without a
debugger attached.

## Logging format

Artifacts are written as **newline-delimited JSON (NDJSON)**, one event per
line, UTF-8, with no pretty-printing. A single event looks like:

```json
{"ts":"2026-09-22T10:14:03.512Z","level":"info","trace_id":"trace_01J8Z3K4Q2V9N7M6B5X4C3T2R1","span_id":"span_0007","task_id":"task_78cbf848c6c4","dispatch_id":"ctx_f5f5b385d594","stage_id":"expert-power-drafter","agent":"omp","event":"contract.written","message":"wrote empirical proof","duration_ms":412,"error":null}
```

Required fields: `ts` (RFC 3339 UTC), `level` (`debug|info|warn|error`),
`trace_id`, `span_id`, `event`. Optional: `task_id`, `dispatch_id`, `stage_id`,
`agent`, `message`, `duration_ms`, `error`. Unknown fields are permitted; never
rename the required ones.

Log files are named `.orchestration/artifacts/<trace_id>.log`.

## Trace ID convention

- A trace starts when a Dispatch is created and ends when `worker_done` settles.
- `trace_id` is `trace_` followed by a 26-character Crockford-base32 ULID. It is
  generated once per Dispatch and propagated to every sub-span, stage and
  sub-worker. Never regenerate a `trace_id` mid-trace.
- `span_id` is `span_` plus a zero-padded 4-digit counter, unique within a trace,
  incremented once per logical operation (stage start, command run, contract write).
- The pair `(task_id, dispatch_id)` from the Orca preamble must be copied verbatim
  onto every event; they are the join keys used by the coordinator.

## Retention policy

| Class | Retention | Notes |
|---|---|---|
| Successful traces (`outcome=succeeded`) | 30 days | Purged nightly. |
| Failed traces (`outcome=failed`) | 90 days | Kept longer to support retros. |
| Any trace referenced by an open contract | until the contract is superseded | Never auto-purged. |
| Raw logs | rotate at 50 MB per file | Compress with gzip after rotation. |

Retention is enforced by a scheduled purge; until that job exists (tracked in
`CHANGELOG.md`), prune manually and never delete a trace linked to an active
contract. `.log` files are git-ignored; only `.gitkeep` and this README are tracked.
