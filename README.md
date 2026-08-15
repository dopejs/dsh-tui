# dsh-tui

`dsh-tui` is a terminal user interface for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It is
distributed as an out-of-tree Harness bundle and runs in the same process as
the agent runtime.

> [!IMPORTANT]
> This repository contains the `0.1.0-rc.1` release candidate. Its tarball is
> installable into a clean `dsh` profile and has automated fresh-session,
> resume, interaction, teardown, and terminal-restoration coverage. It has not
> been published to npm from this repository yet.

## Capabilities

The TUI:

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

## Install from this checkout

Prerequisites are Node.js `^22.19.0 || >=24.0.0` and pnpm `11.7.0`.

```bash
pnpm install --frozen-lockfile
pnpm check
npm pack --pack-destination /tmp
pnpm dlx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile tui add \
  /tmp/dopejs-dsh-tui-0.1.0-rc.1.tgz
pnpm dlx @deepseek-ai/dsh@0.1.0-rc.6 --profile tui
```

Start a persisted session again with:

```bash
pnpm dlx @deepseek-ai/dsh@0.1.0-rc.6 --profile tui --resume <session-id>
```

Press Enter to submit, Ctrl-S to steer, and Ctrl-C to clear or cancel according
to the current state. Use `/exit` for a graceful, durable shutdown. Approval
prompts accept `y` or `n`; structured questions use arrows, Space, Tab, and
Enter.

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
and the installable `0.1.0-rc.6` package artifacts published from that source
baseline. Harness is still a developer preview, so compatibility is tracked
explicitly rather than assumed.

## Development

```bash
pnpm check
pnpm build
pnpm bench
```

The check verifies documentation links, extensionless local TypeScript imports,
lint, TypeScript types, unit tests, fixed-size rendering snapshots, and PTY
lifecycle tests. `pnpm test:package` additionally builds and installs the actual
tarball into a clean temporary profile, then exercises fresh and resumed PTY
sessions. The benchmark compares the selected Ink adapter with the low-level
Terminal Kit spike; its local timing remains diagnostic rather than a portable
CI budget.

CI runs the blocking check on Linux, macOS, and Windows, and covers both the
minimum Node 22 baseline and the current Node 24 line. POSIX process-signal PTY
cases run on Linux and macOS; Windows runs the interactive Ctrl-C and supported
terminal lifecycle paths.

## License

[MIT](LICENSE)
