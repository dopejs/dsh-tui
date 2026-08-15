# dsh-tui

`dsh-tui` is a planned terminal user interface for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It will be
distributed as an out-of-tree Harness bundle and run in the same process as the
agent runtime.

> [!IMPORTANT]
> This repository is in Milestone 1 development. It contains a tested terminal
> lifecycle shell and a loader-aware Cordis runtime mount, but not an
> installable TUI bundle or agent integration. The package remains private
> until the first end-to-end vertical slice is usable, so `dsh plugin` cannot
> mistake the shell for a working application.

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

```bash
pnpm check
pnpm build
pnpm bench
```

The check verifies documentation links, lint, TypeScript types, unit tests,
fixed-size rendering snapshots, and PTY lifecycle tests. The benchmark compares
the selected Ink adapter with the low-level Terminal Kit spike; its local timing
is diagnostic and is not yet a portable CI budget.

CI runs the blocking check on Linux, macOS, and Windows, and covers both the
minimum Node 22 baseline and the current Node 24 line. POSIX process-signal PTY
cases run on Linux and macOS; Windows runs the interactive Ctrl-C and supported
terminal lifecycle paths.

## License

[MIT](LICENSE)
