# ADR-0001: Use an in-process Harness bundle

- Status: Accepted
- Date: 2026-08-15

## Context

DeepSeek Harness composes applications as ordered Cordis plugin bundles. Its
documented UI integration path is to drive `ctx.agents` and render
`session/event`. The shipped headless bundle already demonstrates a serverless,
same-process agent owner, while the Web bundle adds a much larger host, proxy,
HTTP, and browser stack.

Possible TUI topologies were:

1. an in-process bundle over `dsh-base`;
2. a remote client of Web ApiProxy;
3. a fork or modification of the Web client;
4. a new standalone agent implementation.

The TUI needs exact live-agent identity for approval and user-question routing,
agent-scoped tool presentation, command discovery, session projections, and
owned create/resume disposal.

## Decision

Build `dsh-tui` as an out-of-tree bundle mounted in the same `dsh` process as
the agent. Its runtime is a normal Cordis plugin and uses only documented public
Harness services and events.

Do not mount ApiProxy, Host, HTTP, Web runtime, or browser-client packages in the
initial product. Do not add a speculative transport interface. Remote operation
requires a separate future ADR and concrete product requirements.

## Consequences

### Positive

- Direct access to correct agent scope and identity.
- No duplicated wire protocol or server lifecycle.
- Natural installation through a `tui` profile and user patch layers.
- Small dependency surface compared with the Web bundle.
- The project can evolve independently and later move upstream.

### Negative

- The TUI cannot initially attach to an already-running remote Harness process.
- Terminal and agent share one process failure domain.
- Harness release-candidate API changes require tightly managed compatibility.

## Alternatives rejected

### ApiProxy client first

This adds authentication, transport versioning, reconnection, mux ordering, and
human-interaction routing before a local TUI has validated its user experience.
It also composes server infrastructure that local terminal use does not need.

### Reuse Web client internals

Web state and renderers are React/browser-specific. Depending on them would make
the TUI sensitive to private client architecture and still leave terminal input
and lifecycle unsolved.

### Fork Harness

A fork creates long-term merge and release burden even though the public plugin
architecture already supports an external bundle.
