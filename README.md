# dsh-tui

`dsh-tui` is a planned terminal user interface for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It will be
distributed as an out-of-tree Harness bundle and run in the same process as the
agent runtime.

> [!IMPORTANT]
> This repository is in the design phase. It does not yet contain an installable
> TUI bundle. The package remains private until the first end-to-end vertical
> slice is usable, so `dsh plugin` cannot mistake a design scaffold for a working
> application.

## Direction

The TUI will:

- create and resume agents through `ctx.agents`;
- render the durable `session/event` log without depending on Web client code;
- use tool-owned presentation intents for terminal, diff, search, read, and Web
  results;
- provide terminal adapters for approvals, user questions, and commands;
- treat every acquired agent handle, listener, prompt, and terminal mode as an
  explicitly owned resource;
- stay compatible with user profile patches and third-party Harness plugins.

The initial architecture is deliberately same-process. A remote transport can
be considered later as a separate adapter and product mode, not mixed into the
first implementation.

## Documentation

- [Product requirements](docs/product-requirements.md)
- [Architecture](docs/architecture.md)
- [Implementation plan](docs/implementation-plan.md)
- [Testing strategy](docs/testing-strategy.md)
- [Upstream compatibility](docs/upstream-compatibility.md)
- [Architecture decisions](docs/decisions/README.md)

## Current baseline

The design was validated against DeepSeek Harness commit
[`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/commit/47f943859bef60e4160492346772ded9b24f765a)
(`0.1.0-rc.5`). Harness is still a developer preview, so compatibility is
tracked explicitly rather than assumed.

## Development

The repository currently has no third-party development dependencies.

```bash
pnpm check
```

The check verifies the documentation inventory and local Markdown links. Build,
typecheck, unit-test, snapshot, and PTY-test commands will be introduced with
the runtime milestones that need them.

## License

[MIT](LICENSE)
