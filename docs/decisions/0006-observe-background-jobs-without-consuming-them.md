# ADR-0006: Observe background jobs without consuming them

- Status: Accepted
- Date: 2026-08-16

## Context

The job panel needs to list background work, show its lifecycle state, announce
completions, and cancel work this session owns. Harness rc.6 exposes all of it
through `ctx.jobs` (`@deepseek-ai/dsh-jobs`), but two seams on that registry are
not passive observers:

- `JobRegistry.read()` is the only output seam. It consumes: it advances the
  job's single read cursor and marks the record `reported`. A reported record
  suppresses the model-facing completion notice, because the registry treats
  "reported" as "some reader already took delivery."
- `JobRegistry.attachController()` declares that the registering scope can
  collect and stop work for the owners it serves. `start()` refuses to admit a
  job when no attached controller serves its owner, so attaching is an
  admission gate, not a subscription.

A viewer that called either one would change agent-loop behavior. Tailing output
would steal the agent's own work product and silently suppress its completion
notice; attaching a controller would admit jobs on the strength of a collector
that never collects.

## Decision

The job panel consumes only the non-mutating registry seams:

- `list(caller)` for the bounded visible set and `get(id, caller)` for a single
  row — `get()` is documented as non-consuming and leaves the read cursor and
  notice state untouched;
- `onJobsChanged()` to re-read the visible set, and `onJobDone()` for bounded
  completion notices, filtering both to this exact agent and to unowned jobs;
- `kill(id, caller, reason)` behind a two-step confirmation, which does mark the
  record reported — that is inherent to cancelling, and the user asked for it.

`read()` and `attachController()` are never called. The panel reports output as
`unsupported-consuming-read` rather than rendering a partial or stolen tail, and
the controller exposes no method that could reach either seam.

## Consequences

### Positive

- The agent loop's completion notices and output delivery are unaffected by
  whether a human has the panel open.
- Job admission keeps its real safety gate: only a scope that can actually
  collect work admits it.
- Cancellation remains the one deliberate, confirmed state change, scoped to
  jobs this session owns.
- Selection is anchored to a job id, so registry churn cannot retarget a
  confirmation at a different job.

### Negative

- The panel cannot show live or final job output on this baseline. A user who
  needs it reads the transcript, where the owning tool reports it.
- Status detail is limited to what the producer publishes in `JobSnapshot`.

## Alternatives rejected

### Tail output through `read()` and re-emit it

The read cursor is single-consumer and marking the record reported suppresses
the agent's notice. There is no public way to read without consuming, and no way
to restore a suppressed notice.

### Attach a controller so the panel can read and stop jobs

Attaching claims collection capability the panel does not have. It would loosen
`start()`'s refusal — the gate that stops a producer from beginning work nobody
can collect or stop — in exchange for output the panel still must not consume.

### Mirror job output into the durable session log

The TUI does not write durable session data; the log is Harness-owned and is the
transcript's only source of truth.
