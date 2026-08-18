# Product design: production TUI

## Purpose

This document defines the local terminal product that follows the interactive
MVP. The target is a keyboard-first coding workspace with the daily usability,
safety, orchestration, and extension visibility expected from tools such as
Claude Code, while preserving DeepSeek Harness ownership and event semantics.

The target is measured as product capability **and** interface parity. An
earlier revision of this document said "product capability, not visual
imitation"; that was wrong about the goal, and building to it produced a tool
whose surface was materially harder to use than its references. Interface work
is tracked in [M6 roadmap](roadmap-m6.md). Harness is
the authority for agents, sessions, commands, permissions, tools, projections,
skills, and plugins. The TUI owns terminal editing, layout, navigation, local
preferences, and presentation state.

## Product completion model

The verified MVP is the 25% baseline. Five milestones add the remaining 75
percentage points:

| Milestone | Range | Product outcome |
| --- | ---: | --- |
| M1 Daily Driver | 25–45% | A session can be used comfortably for sustained development. |
| M2 Safety & Recovery | 45–62% | Authority and changes are inspectable; supported recovery is explicit. |
| M3 Orchestration | 62–78% | Plans, domain state, jobs, and subagents are observable and controllable. |
| M4 Extension Workbench | 78–90% | Configuration and extension capabilities are discoverable and diagnosable. |
| M5 Productization | 90–100% | Interactive and automation entry points are installable, diagnosable, and accessible. |

Percentages move only when a milestone slice meets its documented acceptance
tests. A rendered placeholder, unowned async operation, or capability inferred
from a private upstream module contributes zero progress.

## Interaction model

### Primary regions

The screen has four stable regions:

1. A compact header identifies session, workspace, model, permission mode, and
   agent state.
2. A bounded transcript viewport renders durable session history. User scroll,
   search results, and expanded tool cards are presentation state only.
3. An optional workbench panel shows one selected domain view: sessions,
   changes, plan, usage, jobs, agents, or extensions.
4. A multiline composer and status line remain at the bottom. Modal human
   interactions exclusively own input while active.

At narrow widths the workbench becomes a full-screen overlay and metadata
collapses in priority order. Transcript content is never silently covered by an
unaccounted overlay.

### Focus and overlays

Exactly one surface owns keystrokes:

```text
approval/question > overlay > transcript search > composer
```

Opening an overlay suspends, but does not discard, the composer draft. Escape
closes one layer at a time. Ctrl-C retains its existing safe escalation:
cancel an owned command, clear a non-empty draft, cancel the active agent, then
request graceful exit. Modal requests for a different live agent are never
displayed by the attached agent's terminal.

The initial default bindings are:

| Action | Binding |
| --- | --- |
| Submit | Enter |
| Insert newline | Ctrl-J or Alt-Enter |
| Steer | Ctrl-S |
| Command palette | Ctrl-P |
| Session center | Ctrl-O |
| Transcript search | Ctrl-F |
| History search | Ctrl-R |
| Workbench | Ctrl-B |
| Cancel/clear/exit escalation | Ctrl-C |

Bindings are commands, not hard-coded component branches. User overrides are
validated for collisions and applied atomically. Terminals that cannot
distinguish a binding expose the same action through the command palette.

## M1 — Daily Driver

### Multiline composer

The composer is backed by a framework-neutral editor reducer. Its state contains
text, cursor, optional selection anchor, bounded undo/redo stacks, preferred
column, history cursor, and input mode. Operations work on Unicode code points;
rendering converts the model to terminal cells.

Required behavior:

- cursor motion by character, word, visual line, document edge, and page;
- insertion, range deletion, selection, undo, redo, and kill/yank operations;
- newline insertion independent of submission;
- bracketed-paste batching so pasted newlines never submit;
- a bounded, process-local command history that excludes secrets entered in
  approval/question modals;
- prefix and reverse history search;
- command and workspace-path completion with deterministic ranking;
- drafts survive overlay changes and rejected submissions;
- input remains bounded at the existing 100,000 UTF-16 code-unit limit.

The first production mode is Emacs-compatible. The reducer admits a future Vim
keymap, but M1 does not claim Vim behavior without a complete modal editing
test matrix.

### Transcript navigation

The durable log remains the only transcript truth. A viewport controller adds
bounded ephemeral state:

- follow-tail until the user scrolls away;
- line/page/start/end navigation and a visible unseen-row count;
- literal case-insensitive search over retained projected rows;
- next/previous match and stable focus by durable row id;
- fold/expand per tool card, with a global compact toggle;
- copy-oriented plain-text projection without terminal decoration.

Search explicitly reports when reducer eviction means older rows are outside
the local window. It does not read persistence artifacts behind the session
service.

### Session center

The session center consumes `ctx.sessionPersistence.list()` and `inspect()`.
Rows show title when available, session id, workspace, creation/update metadata,
and lightweight lineage. Search matches only loaded metadata unless the
deployment has an enabled `sessionQuery` search backend.

Switching sessions is a runtime transition, not a renderer trick: input is
disabled, pending terminal-owned work is settled, the exact old `AgentHandle`
and listeners are disposed, the selected session is resumed, and then input is
enabled. A failed switch leaves a recoverable error and either restores the old
attachment or exits cleanly; two live root handles are never retained as an
accidental fallback.

Rename, fork, and export are shown only when their owning public service exposes
the operation. Missing capability is labeled unavailable rather than emulated
by rewriting a persistence artifact.

### Command palette and status

The palette is a fuzzy-filtered projection of `ctx.commands.list()` plus a
small set of TUI-local navigation commands. Harness owns command names,
descriptions, argument parsing, execution, cancellation, and durable recording.
The TUI owns selection and rendering.

The status line shows agent state, model, permission mode, context/usage when a
projection exists, background activity, viewport position, and active keymap.
Unavailable facts are omitted, never fabricated.

## M2 — Safety & Recovery

### Permission control

Permission presets come from `ctx.permissionPresets`. The UI shows the preset's
sandbox and approval consequences before applying it. A permission change is
an atomic service operation; the status bar changes only after the service
confirms the new mode. The most dangerous preset requires an explicit modal
confirmation and is never selected by cycling through modes with one key.

The workbench exposes:

- effective preset and whether it was inherited or changed in-session;
- sandbox mode and workspace boundary;
- approval policy;
- failures or missing services that prevent a requested transition.

### Change review

Diff presentation intents are indexed by durable tool-call id. The changes view
groups them by file, preserves truncation markers, and opens the corresponding
transcript event. It is an audit view, not a second filesystem truth.

Accept/reject-before-execution stays in the Harness approval seam. Per-file
post-execution revert is enabled only when an owning public checkpoint service
can prove the exact tracked mutation and rollback boundary. The TUI must never
claim that arbitrary Bash, external processes, or untracked writes can be
rewound.

### Checkpoints and recovery

Conversation fork/export and Harness session durability are distinct from file
rollback. Each capability is labeled separately:

- **durable session**: append-only events can be resumed;
- **conversation fork**: a public session service can create a new lineage at a
  documented event boundary;
- **file rewind**: an upstream checkpoint owner can restore only the mutations
  it recorded.

On the pinned rc.6 baseline there is no public file-rewind contract. Production
behavior is therefore fail-closed: the UI reports the capability as unavailable
and links the limitation in diagnostics. Completion of file rewind requires a
future public Harness seam and a compatibility update; importing upstream
implementation files or reverse-applying guessed diffs is forbidden.

## M3 — Orchestration

### Projection panels

`ctx.sessionProjections.snapshot()` and `onChanged()` feed immutable,
framework-neutral view models for goal, todo, plan, usage, and subagent state.
Unknown projection values get a bounded diagnostic representation. The TUI does
not fold domain events into a competing goal/todo database.

### Background jobs

The jobs service owns process/job identity, logs, state transitions, and
cancellation. The panel supports list, attach to bounded output, detach,
cancel, and refresh. Disposal unsubscribes and awaits every in-flight read; the
TUI never kills an unverified process id directly.

### Subagents

The subagent view is a tree keyed by Harness agent/session identity. It shows
provider, label, state, parent, current task, and unread activity when the
projection provides them. Supported public controls—message, follow-up,
interrupt, cancel, attach—are surfaced without routing root-agent approvals or
questions across identities.

## M4 — Extension Workbench

### Preferences

TUI preferences have a versioned schema and deterministic precedence:

```text
defaults < Harness settings namespace < process-session overrides
```

Supported values include theme, keymap bindings, panel placement, default tool
folding, timestamp visibility, and reduced-motion/color choices. Invalid
settings preserve the last valid snapshot and emit an actionable diagnostic.

### Skills, hooks, MCP, and plugins

The workbench is read-mostly and consumes public registries:

- skills: provider, name, description, discovery completeness, and explicit
  invocation text;
- hooks: configured protocol/provider and last observable failure when exposed;
- MCP: server-qualified tools, transport state when exposed, and configuration
  ownership;
- plugins: loader entry, enabled state, fiber phase, and failure diagnostics.

Mutation is offered only through an owning settings/loader service with a
transactional operation. Editing arbitrary YAML from the renderer is not an
acceptable plugin manager. Secrets and MCP headers are never rendered.

## M5 — Productization

### Non-interactive execution

When stdin or stdout is not a TTY, startup selects a separate line-oriented
runner instead of mounting Ink. It supports piped input and these output
formats:

- `text`: final assistant text and diagnostics on stderr;
- `json`: one versioned final envelope;
- `stream-json`: versioned NDJSON events with stable ordering.

The runner uses the same attachment, input, transcript, cancellation, and
disposal controllers as interactive mode. It refuses human approval/question
requests unless an explicit safe policy/provider is configured; it never waits
forever on an invisible prompt.

### Diagnostics and accessibility

`--doctor` performs read-only checks for Node/Harness compatibility, TTY
capabilities, required services, workspace access, persistence, configured
models, and extension health. It redacts secrets and returns a non-zero status
for blocking failures.

Accessibility requirements include no-color mode, high-contrast semantic
tokens, reduced animation, complete keyboard operation, screen-reader-friendly
plain output, and no information conveyed by color alone.

### IDE, attachments, worktrees, and remote mode

File references use terminal-safe absolute paths and optional OSC 8 links.
Images and attachments are accepted only through the Harness attachment seam
and degrade to named metadata when the terminal has no image protocol.

Worktree creation or switching uses an owning Harness/workspace service or an
explicit launcher operation with rollback. Remote attachment remains a separate
product mode. It will not introduce a transport abstraction until a second
concrete transport is implemented and an ADR defines authentication,
capability negotiation, ordering, reconnect, and human-interaction routing.

## Reliability and budgets

All user-controlled collections are bounded: editor history, undo states,
completion candidates, search matches, viewport rows, expanded cards,
diagnostics, job output, projections, and extension lists. Async searches and
catalog reads are abortable and generation-checked so stale results cannot
replace newer input.

The runtime owns attachments, subscriptions, terminal state, commands,
providers, background reads, and renderer shutdown in one reverse-order
resource graph. Session transitions use the same ownership rules as process
exit.

The release budgets are:

- interactive key-to-frame p95 below 50 ms for the bounded visible model;
- no more than 20 transcript frames per second while streaming;
- session/extension searches retain at most 200 results per view;
- editor undo and history retain at most 200 entries each;
- graceful shutdown settles owned work within five seconds before launcher
  escalation;
- `stream-json` preserves durable event order and never writes UI decoration to
  stdout.

## Definition of done

A slice is complete only when its user path, unavailable-capability behavior,
failure recovery, and disposal path are covered. Required evidence is:

- deterministic reducer/controller tests;
- fixed-size snapshots for visible changes;
- PTY tests for terminal and keystroke behavior;
- Harness integration tests for public service use;
- clean-tarball installation tests for changed entry points;
- typecheck, lint, import-boundary check, and documentation check;
- a focused production review followed by fixes;
- a pushed commit and green blocking CI.

