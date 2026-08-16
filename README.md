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
pnpm dlx --allow-build=node-pty @deepseek-ai/dsh@0.1.0-rc.6 \
  plugin --profile tui add \
  /tmp/dopejs-dsh-tui-0.1.0-rc.1.tgz
pnpm dlx --allow-build=node-pty @deepseek-ai/dsh@0.1.0-rc.6 --profile tui
```

Start a persisted session again with:

```bash
pnpm dlx --allow-build=node-pty @deepseek-ai/dsh@0.1.0-rc.6 \
  --profile tui --resume <session-id>
```

Select an exact provider/model before creating a new session with:

```bash
pnpm dlx --allow-build=node-pty @deepseek-ai/dsh@0.1.0-rc.6 \
  --profile tui --model deepseek-official/deepseek-v4-flash
```

The route is resolved through the public Harness model registry before any
agent or session is created. `--model` is intentionally rejected with
`--resume`; resumed sessions retain their established selection semantics.

The composer supports multiple lines, Unicode cursor movement, selection,
undo/redo, bounded command history, and bracketed paste. Press Enter to submit,
Ctrl-J or Alt-Enter to insert a newline, Ctrl-S to steer, and Ctrl-C to clear or
cancel according to the current state. Use arrows/Home/End to edit, Up/Down at
the document boundary to recall history, and `/exit` for a graceful, durable
shutdown. Approval prompts accept `y` or `n`; structured questions use arrows,
Space, Tab, and Enter.

The transcript follows new output until navigation detaches it. Use Ctrl-Up or
Ctrl-Down for one retained entry, PageUp or PageDown for a page, and Ctrl-Home
or Ctrl-End for the retained window boundaries. Ctrl-F opens bounded transcript
search. Ctrl-T folds the focused tool, Ctrl-Shift-T toggles compact tool cards,
and Alt-PageUp or Alt-PageDown pages through a long focused tool result.
Ctrl-Shift-C requests an OSC 52 copy of the currently visible transcript when
the terminal supports it.

Ctrl-P opens a fuzzy command palette that combines the exact agent's Harness
commands with TUI navigation actions. Selecting an argument-free command runs
it; a command with an input hint is inserted into an empty composer for review.
Tab completes a leading slash-command, an explicit `@workspace/path`, or a
path-like token containing a directory separator. Completion is bounded to the
current workspace and never discards an existing draft.

The header degrades by terminal width and shows only available facts: exact
model, permission/approval state, cumulative reported tokens and context
capacity, then workspace. Missing upstream facts are omitted rather than
guessed. Default key bindings and the `default`/`no-color` theme vocabulary are
validated as one atomic preference object; persistence and user editing arrive
with the M4 preference workbench.

Ctrl-O opens the bounded session center. Type to filter persisted-session
metadata, use arrows to select, Space to inspect durable event metadata, R to
refresh, and Enter to switch. Switching is allowed only with an idle agent and
empty composer; the old attachment is fully flushed and disposed before the
selected session resumes.

Open the command palette and choose **Open permissions** to inspect every
Harness-provided preset before changing it. Each row shows the resulting
sandbox mode and approval policy. Safe presets apply directly to the exact
attached session; `danger-full-access` requires typing
`enable danger-full-access` in full. Escape cancels confirmation without
changing either permission knob. Typing the upstream
`/permission danger-full-access` command is also treated as explicit selection.

## Documentation

- [Product requirements](docs/product-requirements.md)
- [Production product design](docs/product-design.md)
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
