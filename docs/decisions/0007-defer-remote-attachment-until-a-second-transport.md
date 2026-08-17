# ADR-0007: Defer remote attachment until a second transport exists

- Status: Accepted
- Date: 2026-08-17

## Context

The production roadmap reserved a remote mode: attaching the TUI to a Harness
running somewhere else. Harness rc.6 ships SDK and API packages built for other
products, and the plugin-inventory gateway shows the shape a remote seam takes
here — a `TypertRemoteService` addressed by trusted clients.

The local runtime is built on assumptions a remote transport does not preserve.
Attachment returns an owned `AgentHandle` whose disposal is ordered against the
session coordinator. Durable `session/event` arrives in sequence from an
in-process store. Approvals and questions are answered by the exact live agent,
and the job registry fences access on the owner's session id. Every one of those
is a same-process guarantee.

## Decision

Remote attachment stays out of the local runtime. The TUI attaches only to an
agent in its own process.

Workspace selection is scoped to what the local runtime can prove: sessions are
grouped and filtered by their durable header `cwd`, and moving between
workspaces is reported as launcher-owned rather than performed — the TUI runs
inside an already-composed process and cannot re-root it without invalidating
every live handle it holds.

Remote mode may be implemented only after both of these hold:

1. a second concrete transport exists, so the seam is designed against two real
   implementations rather than generalized from one;
2. a superseding ADR covers authentication, capability negotiation, reconnect,
   event ordering and gap detection across a disconnect, and how human
   interaction is routed to the exact agent that asked.

## Consequences

### Positive

- No speculative abstraction is carried by code that has one implementation.
- Ownership, ordering, and exact-agent interaction routing keep their
  same-process guarantees, which is what the failure-recovery matrix tests.
- Session browsing still spans worktrees, because the durable `cwd` is a local
  fact that needs no transport.

### Negative

- A session started in another worktree is browsable but not resumable in place;
  the user is told which root to relaunch from.
- Attaching to a Harness on another machine is not possible in this release.

## Alternatives rejected

### Add a transport abstraction now

With one implementation, the abstraction would encode this process's
assumptions — synchronous handle disposal, in-order local events, a live agent
reachable for approval — and the second transport would have to break it.

### Re-root the running process on a workspace change

Changing the working directory underneath live agents, sessions, and tool
executions invalidates handles the TUI does not own. The launcher composes the
process and is the only owner that can start one in a different root.

### Treat any session's `cwd` as resumable

Resuming a session recorded in another worktree would run its tools against the
current root. The recorded path is durable metadata about where the work
happened, not an instruction to change where the process runs.
