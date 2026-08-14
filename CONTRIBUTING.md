# Contributing

`dsh-tui` is currently in its architecture and vertical-slice phase. Small,
reviewable changes that preserve the documented dependency direction are
preferred.

## Before opening a change

1. Read [the architecture](docs/architecture.md) and the accepted
   [architecture decisions](docs/decisions/README.md).
2. Check the [implementation plan](docs/implementation-plan.md) for milestone
   scope and explicit non-goals.
3. If the change depends on a new DeepSeek Harness API, first document why the
   existing public seams are insufficient.

## Verification

For the current documentation scaffold:

```bash
pnpm check
```

Runtime milestones will add TypeScript, reducer, snapshot, and pseudo-terminal
test gates. Do not weaken or bypass a failing gate.

## Architecture decisions

Create a numbered ADR under `docs/decisions/` when a change affects process
topology, package boundaries, durable state, compatibility, UI framework, or
resource ownership. Include context, decision, consequences, and alternatives.
