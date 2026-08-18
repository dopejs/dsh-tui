# dsh-tui

`dsh-tui` is a terminal user interface for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It is
distributed as an out-of-tree Harness bundle and runs in the same process as
the agent runtime.

> [!IMPORTANT]
> This is `0.5.1`. Harness peers are declared `^0.1.0-rc.6` and optional: the
> `dsh` CLI provides the Harness runtime, so nothing installs them on our
> behalf and npm must not try. Both the global and local installs are verified
> against the host's current `latest` on every CI run.

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

## Prerequisites

The TUI drives a model through Harness, so the profile needs a provider
credential before a session can do anything. Without one, a run fails with the
provider's own message rather than silently producing nothing:

```bash
export DEEPSEEK_API_KEY=...   # or store it through the credentials service
```

Run `dsh --profile tui --doctor` at any time for a read-only check of services,
model selector, session persistence, and terminal capabilities. It starts no
session and runs no agent.

## Install

```sh
npm install -g @deepseek-ai/dsh @dopejs/dsh-tui
dtui
```

`dtui` initializes the `tui` profile on first run and starts it. Every argument
is passed through, so `dtui --resume <id>`, `dtui --doctor`, and
`dtui --print "…"` all work.

The command is `dtui` rather than `dsh-tui`, because
[@deepseek-harness-tui/dsh-tui](https://github.com/ccch1mneyyy/dsh-TUI) already
claims that name and both should be installable side by side.

## Install from this checkout

Prerequisites are Node.js `^22.19.0 || >=24.0.0` and pnpm `11.7.0`.

```bash
pnpm install --frozen-lockfile
pnpm check
npm pack --pack-destination /tmp
pnpm dlx --allow-build=node-pty @deepseek-ai/dsh@0.1.0-rc.7 \
  plugin --profile tui add \
  /tmp/dopejs-dsh-tui-0.5.1.tgz
pnpm dlx --allow-build=node-pty @deepseek-ai/dsh@0.1.0-rc.7 --profile tui
```

Start a persisted session again with:

```bash
pnpm dlx --allow-build=node-pty @deepseek-ai/dsh@0.1.0-rc.7 \
  --profile tui --resume <session-id>
```

Select an exact provider/model before creating a new session with:

```bash
pnpm dlx --allow-build=node-pty @deepseek-ai/dsh@0.1.0-rc.7 \
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
guessed. Default key bindings and the `default`, `high-contrast`, and `no-color` themes
are validated as one atomic preference object. Preferences persist through
`ctx.settings` when a writable provider exists and are reported as
process-only when it does not. Panels name semantic tones rather than colors,
so dropping color loses no information, and a screen-reader mode removes box
drawing. Reduced motion and key-binding overrides live in the same document.

Ctrl-O opens the bounded session center. Type to filter persisted-session
metadata, use arrows to select, Space to inspect durable event metadata, R to
refresh, and Enter to switch. Switching is allowed only with an idle agent and
empty composer; the old attachment is fully flushed and disposed before the
selected session resumes.

Every panel is reachable from the command palette, so a terminal that cannot
emit a chord can still get to all of them:

| Panel | Palette action | Shortcut | What it shows |
| --- | --- | --- | --- |
| Activity | Open activity | Ctrl-Y | Plan, job, and subagent notifications, coalesced, with navigation into the panel that answers each |
| Jobs | Open jobs | Ctrl-B | Background jobs, ownership, status, and cancellation behind a confirmation |
| Subagents | Open subagents | Ctrl-G | The delegation tree with lineage, depth, follow-up, interrupt, and attach |
| Projections | Open projections | Ctrl-U | Plan, todo, goal, and usage read models |
| Skills | Open skills | — | Discovered skills; Enter inserts `/name` for you to submit |
| MCP | Open MCP inventory | — | Bridged tools grouped by server |
| Plugins | Open plugins | — | Loader entries, fiber phase, and failure diagnostics |
| Attachments | Open attachments | — | Stage images for the next message |
| Changes | Open changes | — | Durable tool-presented file edits, linked when the terminal supports OSC 8 |
| Recovery | Open recovery | — | Durability barrier, raw export, and conversation fork |

Some capabilities are reported as unavailable rather than approximated, because
this Harness baseline publishes no seam for them: job output stays with the
owning agent, hooks have no inventory, MCP exposes no connection health, and
plugin enablement has no public transaction. Each panel says so in place.

## Non-interactive use

`--print` runs one prompt with no terminal state and exits:

```bash
dsh --profile tui --print "summarize this repository"
echo "summarize this repository" | dsh --profile tui --print --output-format stream-json
```

`--output-format` selects `text` (default), `json`, or `stream-json`. Envelopes
carry a schema version, arrive in durable event order, and skip events the
contract does not model. stdout carries only run output and stderr only
diagnostics. Exit codes are `0` completed, `1` failed, `2` a run that needed a
human — approvals and questions fail closed, because there is no terminal to
answer on — and `130` cancelled.

Open the command palette and choose **Open permissions** to inspect every
Harness-provided preset before changing it. Each row shows the resulting
sandbox mode and approval policy. Safe presets apply directly to the exact
attached session; `danger-full-access` requires typing
`enable danger-full-access` in full. Escape cancels confirmation without
changing either permission knob. Typing the upstream
`/permission danger-full-access` command is also treated as explicit selection.

Choose **Open changes** in the palette to review bounded, file-grouped diff
presentations and jump back to the retained durable tool event. Choose
**Open recovery** to run an exact-session durability barrier, export a
backend-owned raw artifact without overwriting an existing path, or create an
explicitly confirmed conversation-only fork. Harness rc.6 has no public file
checkpoint owner, so file rewind is shown as unavailable and presented diffs
are never reverse-applied.

## Documentation

- [Product requirements](docs/product-requirements.md)
- [Production product design](docs/product-design.md)
- [Architecture](docs/architecture.md)
- [Implementation plan](docs/implementation-plan.md)
- [Failure recovery matrix](docs/failure-recovery-matrix.md)
- [Testing strategy](docs/testing-strategy.md)
- [Upstream compatibility](docs/upstream-compatibility.md)
- [Architecture decisions](docs/decisions/README.md)

## Current baseline

The design was validated against DeepSeek Harness commit
[`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/commit/47f943859bef60e4160492346772ded9b24f765a)
and the installable `0.1.0-rc.7` package artifacts published from that source
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
