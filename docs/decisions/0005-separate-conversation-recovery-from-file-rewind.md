# ADR-0005: Separate conversation recovery from file rewind

- Status: Accepted
- Date: 2026-08-16

## Context

The TUI needs durability, export, and conversation branching without implying
that an append-only session log can restore workspace files. Harness rc.6 has
public session durability, raw-artifact reads on capable persistence backends,
and agent creation from a validated seed with parent lineage. It has no public
file-checkpoint owner.

A conversation fork must also produce an owned live agent. Calling
`SessionStore.fork()` directly creates a live Session but does not return the
`AgentHandle` required for the TUI's ordered agent-loop teardown and attachment
transition.

## Decision

Expose four separate recovery capabilities:

- durability calls `SessionStore.flush()` for the exact live session and treats
  zero participating listeners as a failed barrier;
- raw export uses only `SessionPersistence.supportsRawArtifacts` and
  `readRaw()`, writing an explicitly chosen destination with exclusive,
  no-overwrite publication;
- conversation fork snapshots the immutable balanced live event prefix after a
  successful durability barrier, then calls `AgentRegistry.create()` with a
  fresh id, `seed`, `seedLength`, and `parentSession` metadata;
- file rewind remains unavailable until a public checkpoint service owns and
  proves the exact mutations it can restore.

The session attachment coordinator owns the fork transition. It blocks input,
fully disposes the parent binding before creating the child, and resumes the
persisted parent if child creation fails. The initiating controller transfers
the accepted transition to this longer-lived owner.

## Consequences

### Positive

- Every label states the actual authority and recovery boundary.
- Forked conversations retain durable lineage and have one exact AgentHandle.
- Parent and child live bindings never overlap.
- Export never overwrites an existing path or follows a destination symlink.
- Diff presentations remain audit data and cannot become an improvised rollback
  engine.

### Negative

- A conversation fork does not copy, reset, or isolate workspace files.
- Backends without raw artifacts cannot use raw export.
- Forking is limited to the current idle, balanced event boundary in this
  release; arbitrary historical boundaries need a public prepare/validation
  contract that does not create an unowned live Session.

## Alternatives rejected

### Reverse presented diffs

Presentations cannot account for Bash, external processes, concurrent writes,
permissions, or untracked files. Reversing them would claim a recovery guarantee
the TUI cannot prove.

### Call `SessionStore.fork()` and attach later

The returned Session has no independently owned AgentHandle. Keeping it live
would conflict with resume; tearing it down through a broad fiber would violate
exact ownership.

### Create the child agent before disposing the parent

That overlaps live bindings and terminal interaction providers. The coordinator
therefore preserves the existing no-overlap transition invariant.
