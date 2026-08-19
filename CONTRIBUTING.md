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

## Releasing

Releases are cut by pushing a tag; there is no manual publish step.

```bash
git tag v0.8.3
git push origin v0.8.3
```

The `Release` workflow then, in order:

1. refuses the tag if it does not match `package.json` — otherwise the tag
   would point at contents carrying a different version;
2. runs `pnpm check`, the same gate `main` is held to;
3. runs `pnpm test:package`, which installs the real tarball into a clean
   profile and launches it, including the bounded `--doctor` and `--print`
   one-shot contracts;
4. publishes to npm under a dist-tag derived from the version — anything with a
   hyphen is a prerelease and goes to `rc`, so an release candidate never
   occupies `latest`;
5. creates the GitHub Release with the tarball attached, marked prerelease on
   the same rule.

Publishing is irreversible in practice: npm restricts unpublishing after 72
hours. The gate runs before the publish for that reason, not after.

