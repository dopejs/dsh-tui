# Contributing

`dsh-tui` is currently a release candidate. Small, reviewable changes that
preserve the documented dependency direction are preferred.

## Before opening a change

1. Read [the architecture](docs/architecture.md) and the accepted
   [architecture decisions](docs/decisions/README.md).
2. Check the [implementation plan](docs/implementation-plan.md) for milestone
   scope and explicit non-goals.
3. If the change depends on a new DeepSeek Harness API, first document why the
   existing public seams are insufficient.

## Verification

For every change:

```bash
pnpm check
```

`pnpm check` runs documentation validation, lint, typecheck, unit/snapshot tests,
and pseudo-terminal lifecycle tests. Use `pnpm build` to verify bundled ESM and
declarations, `pnpm test:package` when changing composition or packaging, and
`pnpm bench` when changing renderer performance. Source TypeScript imports must
remain extensionless; `tsdown` owns runtime ESM generation. Do not weaken or
bypass a failing gate.

## Architecture decisions

Create a numbered ADR under `docs/decisions/` when a change affects process
topology, package boundaries, durable state, compatibility, UI framework, or
resource ownership. Include context, decision, consequences, and alternatives.
