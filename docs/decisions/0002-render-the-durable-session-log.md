# ADR-0002: Render the durable session log

- Status: Accepted
- Date: 2026-08-15

## Context

Harness separates durable `session/event` facts from live `agent/*` coordination.
The session log supports replay, resume, persistence, assistant chunks, tool
activity, and turn boundaries. The current model-visible `session.surface` may
replace or shadow earlier nodes after compaction, while a human has already seen
those earlier messages.

The TUI needs identical transcript meaning across live execution and resume,
without depending on timing-sensitive provider callbacks or browser stores.

## Decision

The human transcript is a pure, sequence-driven projection of the append-only
session event log.

- Subscribe before replay and deduplicate by event sequence.
- Use `assistant/chunk` for the in-flight row and `assistant/message` as its
  completion anchor.
- Preserve prior human-visible append material across model-surface replacement;
  render compaction/replacement explicitly.
- Use `agent/*` only for ephemeral status, inbox, and control state.
- Use domain session projections rather than rebuilding their state locally.

## Consequences

### Positive

- Live and resumed sessions share one reducer and fixtures.
- Transcript behavior can be deterministic and framework-neutral.
- Durable events remain the only history authority.
- Browser client state is not a dependency.

### Negative

- The reducer must understand event correlation and forward-compatible fallback.
- High-frequency chunk events require repaint coalescing and bounded storage.
- The human transcript is not identical to the model's compacted surface and
  must communicate that distinction clearly.

## Alternatives rejected

### Render `session.surface`

This is appropriate for model-visible history, but it can erase shadowed content
that a human previously observed.

### Render only live callbacks

This cannot reproduce a session after restart and creates races around reconnect
or late subscription.

### Port the Web conversation store

That couples the TUI to browser-specific private code and duplicates upstream
presentation decisions instead of consuming core contracts.
