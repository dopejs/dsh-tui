# Architecture

## Summary

`dsh-tui` is an out-of-tree DeepSeek Harness bundle. Its application runtime is
an ordinary Cordis plugin mounted over `dsh-base`. It drives public agent
services in the same process and presents committed session facts through a
terminal-specific view model.

```text
tui profile = dsh-base + @dopejs/dsh-tui + user patch layers

 keyboard ──> input arbiter ──> commands / followup / steer / cancel
                                      │
                                      ▼
                                ctx.agents
                                      │
 session/event ──> transcript reducer ──> view model ──> TUI renderer
 agent/*       ──> live status store  ────────────────┘

 approval/request ─┐
 userQuestions.ask ├──> interaction scheduler ──> modal renderer
 command results ──┘
```

The initial renderer uses Ink 7 behind the terminal adapter, as selected in
[ADR-0004](decisions/0004-select-ink-for-terminal-rendering.md). The renderer
remains replaceable: state and lifecycle layers do not import Ink or React.

## Why same-process

Harness explicitly defines UI integration as driving `ctx.agents` and rendering
from `session/event`. Running beside the agent gives the TUI:

- the exact live `Agent` identity required by approvals and user questions;
- scoped tool definitions and their pure presentation functions;
- direct command and session-projection registries;
- ownership of the `AgentHandle` returned by create/resume;
- no HTTP server, browser host, or duplicated wire protocol.

Remote operation is a different product mode. It would require an authenticated
transport, capability/version negotiation, reconnect semantics, and a human
interaction routing policy. Adding placeholder transport interfaces now would
increase complexity without validating those contracts.

This decision is recorded in
[ADR-0001](decisions/0001-use-an-in-process-harness-bundle.md).

## Package and module boundaries

The first implementation should remain one publishable package until a real
second consumer justifies another capability seam.

```text
src/
├── startup.ts                 application argv -> tuiStartup service
├── index.ts                   Cordis plugin entry and composition root
├── runtime/
│   ├── resource-owner.ts      generic reverse-order async ownership
│   ├── cordis-runtime.ts      loader settlement and runtime ownership
│   ├── agent-attachment.ts    create/resume and event handoff
│   ├── agent-runtime.ts       Cordis-to-Agent composition
│   └── interaction-scheduler.ts
├── model/
│   ├── transcript-reducer.ts  pure durable-event fold
│   ├── editor-controller.ts    bounded multiline editor and history
│   ├── live-state.ts          status/inbox/pending UI state
│   └── view-model.ts          framework-neutral terminal model
├── presentation/
│   ├── content.ts             Harness content-block projection
│   └── tools.ts               tool render-intent projection
└── ui/                        the only terminal-framework-aware directory
```

Avoid one-file-per-trivial-type fragmentation. The boundaries above describe
ownership and dependency direction, not a requirement to create every file
before it has meaningful behavior.

### Allowed dependencies

The runtime may consume documented package exports providing:

- `ctx.agents`, `Agent`, `AgentHandle`, and model-selection helpers;
- `Session`, `SessionEvent`, and `ctx.sessions`;
- `ctx.sessionPersistence` for listing/inspection and agent resume for claiming;
- `ctx.tools` and tool presentation intents;
- `ctx.commands` and command results;
- `ctx.approval` and the `approval/request` waterfall;
- `ctx.userQuestions` and its provider interface;
- `ctx.sessionProjections` for domain read models;
- Cordis effects, events, injection, and loader settlement.

### Forbidden dependencies

- Upstream `packages/client/*` React stores, assemblers, or components.
- `agent-loop/src/*` or any other unexported implementation file.
- `host/apiproxy` in the same-process product.
- Direct reads of persistence artifacts for normal transcript rendering.
- Tool-name-specific UI policy when a render intent or generic fallback exists.

## Bundle composition

The package publishes this distribution metadata:

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

The patch adds only terminal-specific rows:

1. `tui-startup`, which injects `cmdlineArgs`, parses application arguments, and
   provides immutable startup values.
2. `tui-runtime`, which injects the startup service and required core services.
3. A code-runtime row only if the base profile does not already compose the
   selected tool-presentation runtime.

It must not mount ApiProxy, Host, Web server, Web runtime, or browser-client
rows. User patches remain later layers and can replace TUI configuration.

## Agent ownership and attachment

The runtime waits for loader settlement before creating an agent, following the
same rule as the shipped headless runner. It then either:

- calls `ctx.agents.create()` with a fresh session id, workspace metadata, model
  selection, and agent-scoped setup; or
- calls `ctx.agents.resume()` with the requested persisted session id.

Both return an `AgentHandle`. The runtime owns that exact handle and no other
component may dispose it.

### Replay/live handoff

After attachment:

1. Register the agent-scoped `session/event` listener.
2. Snapshot `agent.session.events`.
3. Fold the snapshot and any concurrently received events through the same
   reducer.
4. Ignore an event whose sequence has already been applied.
5. Only after the view is current, enable user submission.

Listener-first prevents gaps. Sequence deduplication makes duplicate delivery
from the snapshot harmless.

The live listener never executes rendering work inside the synchronous
`session/event` dispatcher. It marks the session dirty and an owned serial pump
re-reads immutable log snapshots in batches of at most 256 events. The log,
not an unbounded callback queue, remains the recovery source when several
events arrive during one render update.

A framework-neutral transcript controller folds each accepted batch
synchronously, then schedules at most one subscriber notification for the next
event-loop turn. React consumes its stable snapshot through the external-store
contract, closing the read-before-subscribe race without moving framework types
outside `src/ui/`. Disposal cancels a pending notification, unregisters every
subscriber, and awaits owned asynchronous error reports.

## Durable transcript model

The append-only session log is the source of truth. The transcript reducer is a
pure function over ordered events and uses event sequence as stable identity.
It retains at most 2,000 materialized rows and 20,000 UTF-16 code units per row
by default; both limits are configurable within validated hard ceilings, and
eviction/truncation remains visible in the projected state.

The TUI must not equate the human transcript with `session.surface`. The surface
is the current model-visible projection and can shadow earlier nodes after
compaction. A human transcript preserves append-origin material and renders the
compaction or replacement as an explicit event rather than erasing what the
user previously saw.

### Assistant streaming

- `assistant/chunk` appends to an in-flight assistant row associated with its
  step/request coordinates.
- `assistant/message` is the completion anchor and identifies source chunk
  sequences.
- On completion, the reducer reconciles the anchor with those chunks and retains
  one message.
- Replaying a completed session produces the same final row without relying on
  timing or live provider callbacks.

### Tool activity

Tool calls and results correlate by call id. For the active agent scope, the
presenter resolves `ctx.tools.get(name, agent)` and invokes `presentCall` or
`presentResult` when supplied. The resulting tagged intent maps to terminal
widgets:

| Intent | Terminal treatment |
| --- | --- |
| `generic` | Header plus bounded content/detail view |
| `terminal` | Command, cwd, output, exit code or signal |
| `diff` | File list and colored unified/context diff |
| `search` | Grouped matches or paths with truncation state |
| `read` | Line-numbered, optionally highlighted source |
| `web` | Search/fetch summary and sources |

Presentation is replay-time pure and may return `undefined`. Missing definitions,
old arguments, or unsupported intents use a generic fallback derived from the
durable event. Presentation failure must never prevent transcript replay.
The projector retains at most 2,000 unresolved calls, 200 detail lines per card,
and 1,000 UTF-16 code units per detail line by default. It resolves every tool in
the exact attached-agent scope, applies the same rules to nested code-dispatch
events, and preserves raw durable result content when a result presenter is
missing or only supplies structural metadata.

The same replay boundary emits structured public diff intents to a separate
change index. That index retains at most 500 changes across 500 files by
default, replaces call-time plans with result-time presentations, and records
successful calls without a result diff as `unverified` rather than claiming a
file mutation was applied. It owns only review navigation and fold state; the
durable transcript remains the history source of truth. Approval prompts may
look up planned paths only by the exact call id.

## Recovery capabilities

Durability, raw export, conversation fork, and file rewind are independent
capabilities. The recovery controller never infers one from another.

`ctx.sessions.flush(exactSession)` is the manual durability barrier. Raw export
is enabled only when `ctx.sessionPersistence.supportsRawArtifacts` is true; the
adapter reads that backend-owned artifact and atomically links a private
temporary file to the user's explicit destination, refusing existing files and
symlinks.

At an idle balanced boundary, a conversation fork snapshots the immutable live
event prefix after flushing and transfers it to `ctx.agents.create()` with a
fresh session id and durable parent/seed metadata. The attachment coordinator
owns the transition: parent disposal completes before child creation, and a
failed child creation restores the persisted parent. The child shares the
current workspace path; it does not rewind files. See
[ADR-0005](decisions/0005-separate-conversation-recovery-from-file-rewind.md).

Harness rc.6 exposes no file-checkpoint owner, so file rewind is an explicit
unavailable state. Tool diff intents are review evidence only and are never
reverse-applied.

## Live state

Live state is deliberately separate from durable transcript state:

- `agent/status` controls busy/idle indicators and available actions;
- inbox events populate queued/steering affordances;
- approvals, questions, input focus, scroll position, expanded cards, and
  notification banners are ephemeral UI state;
- `ctx.sessionProjections.snapshot()` and `onChanged()` provide domain state
  such as todo, permission, usage, or subagent projections.

The TUI must not locally reimplement a domain projection that Harness already
publishes.

## Input routing

One input arbiter owns stdin and focus. It routes a completed entry as follows:

1. If input is a syntactically valid slash command, execute it through
   `ctx.commands.execute(agent, line, signal)`.
2. If it begins with `/` but is unknown or invalid, show a local error and do not
   submit it to the model.
3. Ordinary submission calls `agent.followup(createUserMessage(...))`.
4. The explicit steering action calls `agent.steer(...)`.
5. The cancel action calls `agent.cancel({ kind: 'user' })`.

`whenIdle()` describes whole-agent quiescence, not completion of one message. UI
status and automation must not attribute an idle transition to a specific
follow-up.

The framework-neutral input controller preserves ordinary message text
verbatim, rejects empty input and entries above 100,000 UTF-16 code units by
default, and permits only one asynchronous slash command at a time. Command
cancellation has its own owned signal; agent cancellation always calls the
exact attached agent with `{ kind: 'user' }`. Disposal aborts and awaits the
owned command request before releasing the controller.

### Composer ownership

The multiline composer is an owned framework-neutral editor controller. It
stores text, UTF-16 offsets that always move across complete Unicode scalar and
common joined emoji sequences, selection anchor, bounded undo/redo, bounded
process-local history, and a monotonically increasing text revision. The Ink
adapter alone translates terminal keys and bracketed-paste events into editor
operations and converts offsets into terminal-cell layout.

Submission captures `{ text, revision }`. A successful message or command adds
the submitted text to history and clears the composer only if no later text
edit changed that revision. This prevents an asynchronously completing command
from erasing a newer draft. Rejected, failed, and cancelled submissions retain
the draft. History changes from an older concurrent submission do not invalidate
a newer submission token.

Ink's bracketed-paste hook owns the terminal mode and restores it during
renderer unmount. Terminal CRLF/CR paste boundaries normalize to LF, and pasted
newlines are inserted as one edit transaction that can never trigger
submission. Composer text, undo, and history are bounded by both entry count
and aggregate code units; the
horizontal projector scans only a small window around the cursor instead of a
100,000-code-unit line.

### Transcript viewport ownership

The transcript viewport is a framework-neutral controller subscribed to the
bounded transcript reducer. It owns only ephemeral navigation state: tail
following, retained-row offset, stable focused row id, unseen/evicted counters,
search state, tool-card folding, and tool-detail page offsets. It never appends
or reconstructs durable history. Reducer rows remain immutable and continue to
be the sole transcript truth.

Literal case-insensitive search indexes at most 2,000,000 UTF-16 code units and
retains at most 200 newest match ids. The UI explicitly marks results incomplete
when reducer eviction or the search budget excludes older text. Per-card fold
and page overrides are bounded to 200 ids and are removed when their durable row
is evicted. Expanded cards are projected to the physical screen budget before
the screen window is selected, so one large tool result cannot grow the render
tree without bound.

The adapter may emit OSC 52 only after an explicit copy action, only to a TTY,
and only for a bounded UTF-8 payload. The copied value is a decoration-free
plain-text projection of visible rows; terminal control sequences from durable
content are base64 encoded rather than written as control data.

### Overlay, palette, and completion ownership

One framework-neutral overlay controller owns at most one overlay id. Input
focus is derived in one place with the fixed priority `interaction > overlay >
transcript search > composer`; an approval or question suspends an existing
overlay without destroying it. Escape or Ctrl-C closes the active overlay
before composer or agent cancellation can run.

The command palette projects `commands.list(exactAgent)` together with a small
bounded registry of local TUI actions. It listens for `commands/change`, copies
only descriptor metadata, scans at most 1,000 commands, retains at most 100
ranked results, and never calls a command handler itself. Selecting an
argument-free command inserts its canonical slash invocation and routes it
through the existing `InputController`; commands with input hints are inserted
for editing. A non-empty composer draft is preserved and blocks palette command
insertion rather than being overwritten. Local actions use the same discoverable
palette item vocabulary as Harness commands.

The completion controller parses only a leading slash-command, an explicit
`@path`, or a path-like token containing a directory separator. Requests own an
AbortController and monotonically increasing generation; a stale provider result
cannot publish, and disposal aborts and awaits all admitted work. Results,
metadata, replacements, and concurrent settling requests are bounded.

The Node workspace provider lists only public command descriptors and filesystem
entries under the session workspace. It scans at most 2,000 directory entries,
uses `realpath` containment before listing, does not traverse a symlink outside
the workspace, hides dotfiles unless explicitly requested, and checks the
request signal throughout. The provider returns replacement intent only; the
editor performs the final Unicode-boundary and text-limit validation.

### Startup model and runtime status

For a fresh session, `--model provider/model` is parsed at the first slash so
provider-owned model ids may contain further slashes. The runtime calls the
public `ctx.llm.resolveModelInfo()` contract before acquiring an Agent handle,
then passes the exact selection into the Agent-scoped model-selection seam.
Model override and resume are mutually exclusive at the launcher boundary.

The runtime-status controller consumes the same ordered durable event batches
as the transcript without retaining them. It projects the latest request model
and context capacity, permission preset, approval policy, and bounded cumulative
reported token usage. Unknown or unavailable facts remain absent. Rendering
drops workspace first, then usage, at narrow widths instead of relying on a
single truncated metadata string.

M1 installs a process-local, atomically validated preference shell for semantic
theme names and global action chords. Invalid startup input falls back to the
documented defaults; a collision rejects the entire replacement. Persistent
settings registration and user-editable themes/keymaps remain owned by M4.1.

### Permission transition ownership

The permission panel reads `ctx.permissionPresets.names`, `optionOf()`,
`resolve()`, and `current(session.events)` from the public package root. It
shows sandbox and approval consequences together, but never writes either knob
itself. A safe selection calls `permissionPresets.set()` with the exact attached
`Session`; the upstream service owns validation, durable events, and enforcement.

Any preset resolving to `danger-full-access` enters a local confirmation state
and requires the exact phrase `enable <preset>`. No cycling shortcut applies it.
The upstream slash command remains an explicitly typed alternative. During a
local write, intermediate synchronous knob events are coalesced and the panel
re-reads the durable effective state once. A failure preserves the upstream
state and remains visible. Events for another session never refresh or retarget
the controller. An absent permission service produces an unavailable view.

## Human interaction

The interaction scheduler serializes terminal ownership across the composer,
approval modal, user-question form, and command feedback.

### Approval

The runtime registers an `approval/request` waterfall listener. It answers only
requests whose exact live agent is the attached agent. Any other request calls
`next()`. Abort closes the modal and returns the seam's cancelled result. If the
terminal cannot present the decision safely, the answerer fails closed.

### User questions

The runtime registers the sole `ctx.userQuestions` provider. It renders the
general question vocabulary and optionally recognizes known presentation intents
such as plan review. The provider returns labels/custom text in the existing
generic answer shape and observes the caller's signal.

Switching sessions is forbidden while a modal owns terminal input in the MVP.
Later multi-agent support must define an explicit queue and visible agent identity
before relaxing that rule.

### Session attachment ownership

The runtime owns one `SessionAttachmentCoordinator`. A binding contains the
exact root `AgentHandle`, its durable transcript listener, interaction seams,
controllers, and input-acceptance gate. The session center reads only the public
`ctx.sessionPersistence.list()` and `inspect()` contracts; it never opens
persistence files or reconstructs transcript history.

A transition synchronously closes the binding's input gate and publishes
`switching` before target preflight, so input is blocked even before React can
unmount the old view. Preflight failure reopens the gate and republishes the
untouched old binding.
After successful preflight, the coordinator flushes and fully disposes the old
binding before calling `ctx.agents.resume()` for the selected id. If target
resume fails, it may recreate the previous binding only after the failed target
has proven it owns no live handle. Failure to dispose either handle is fatal,
because restoring in that state could create two live roots.

The stable root renderer subscribes to coordinator snapshots and remounts the
interactive application with a keyed, freshly composed controller graph. Root
disposal first unmounts the renderer, then aborts and awaits session-center work,
then disposes the coordinator and its current binding. This ordering makes
shutdown quiescent during both normal attachment and an in-flight transition.

The scheduler accepts at most 32 pending interactions by default and presents
them serially. Caller and lifecycle aborts settle queued work promptly; disposal
unregisters both Harness seams before aborting and awaiting owned work. Question
answers are validated for exact ids, completeness, option membership,
single/multi-select rules, duplicate selections, and non-empty custom text before
they cross the provider boundary.

## Resource lifecycle

One runtime owner tracks resources in acquisition order:

- raw-mode and alternate-screen terminal state;
- resize and process-signal handlers;
- Cordis listeners/effects;
- command and prompt abort controllers;
- approval answerer and user-question provider;
- renderer task/queue;
- owned `AgentHandle`.

Shutdown stops new input, aborts pending UI operations, closes listeners so late
callbacks are silent, disposes and awaits the agent handle, drains rendering,
and finally restores terminal state. Every path, including startup failure, runs
terminal restoration in `finally`.

The Cordis mount registers its disposer synchronously and runs loader settlement
behind an owned abortable task. It does not return loader settlement from the
plugin callback: doing so would make disposal wait for a loader promise that may
only settle after the same tree finishes unloading. On unload, the mount aborts
settlement/startup, joins the task, and disposes any runtime that completed in
the race exactly once.

## Boundedness and backpressure

- Keep durable facts in the Session, not duplicated indefinitely in UI objects.
- Store a bounded rendered window plus lightweight indexes for older rows.
- Cap expanded tool output and expose truncation or on-demand paging.
- Coalesce high-frequency chunk repaint requests without dropping durable chunks.
- Handle resize by reflowing the visible window, not the complete session.
- Never block the `session/event` dispatcher on terminal rendering.

## Observability

Operational logs go to a separate diagnostic sink or file when the alternate
screen is active; writing arbitrary logs into the UI stream corrupts rendering.
Diagnostics should include session id, agent id, event seq/type, lifecycle phase,
and terminal dimensions without recording secrets or full prompt/tool payloads by
default.

## Failure behavior

The executable injection cases and their attached-session versus clean-exit
postconditions are recorded in the
[failure recovery matrix](failure-recovery-matrix.md).

| Failure | Required behavior |
| --- | --- |
| Resume corruption/unsupported format | Leave terminal clean and show the Harness error. |
| Presenter throws | Log diagnostic and render generic durable fallback. |
| Renderer throws | Stop accepting input, dispose owned work, restore terminal. |
| Approval/question aborts | Close modal, return cancellation, restore composer focus. |
| Persistence flush/disposal fails | Report failure after terminal restoration; do not claim clean completion. |
| Second termination signal | Allow launcher hard-stop behavior; restoration is best effort after escalation. |
| Non-TTY input/output | Refuse with help in MVP; do not enable raw mode. |
