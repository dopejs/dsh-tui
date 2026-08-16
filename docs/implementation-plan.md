# Implementation plan

## Objective and progress accounting

Deliver the complete local production TUI described in
[Product design](product-design.md), starting from the verified interactive MVP
at 25%. Progress points represent accepted product capability, not elapsed time
or code volume. A slice moves the total only after its exit criteria pass.

| Milestone | Slices | Start | End |
| --- | --- | ---: | ---: |
| M1 Daily Driver | M1.1–M1.5 | 25% | 45% |
| M2 Safety & Recovery | M2.1–M2.4 | 45% | 62% |
| M3 Orchestration | M3.1–M3.4 | 62% | 78% |
| M4 Extension Workbench | M4.1–M4.4 | 78% | 90% |
| M5 Productization | M5.1–M5.4 | 90% | 100% |

The implementation proceeds in order because later panels depend on the M1
overlay, focus, viewport, and command infrastructure. Each slice is committed
and pushed independently after its local gates pass. Blocking CI must be green
before the slice is marked complete.

## Delivery invariants

- Import only documented package exports; local TypeScript imports remain
  extensionless and runtime ESM is produced by the bundler.
- Durable `session/event` data remains the only transcript history.
- React and Ink types remain inside `src/ui`.
- Harness owns domain state; the TUI consumes services and projections.
- Every operation has cancellation, generation control, bounded retention, and
  quiescent disposal.
- Capability absence is a tested state. It is not filled with guessed private
  behavior.
- A session switch or runner exit cannot retain an unowned live agent.
- New architecture decisions are recorded as new ADRs.

## M0 — Capability and design baseline (25%)

Status: **complete**. The production product design, M1–M5 acceptance slices,
test expansion, public capability map, unsupported recovery boundary, and
documentation inventory are recorded and pass the repository gates.

Work:

- commit the production product design and this executable plan;
- map each Harness integration to its rc.6 public package/service;
- record unsupported file-rewind and remote-transport boundaries;
- extend test strategy and documentation inventory;
- create a feature acceptance matrix that tests can reference by stable id.

Exit criteria:

- `pnpm check` passes;
- every M1–M5 requirement has an owner, failure mode, and verification layer;
- the documentation commit is pushed and CI is green.

## M1 — Daily Driver (25% → 45%)

### M1.1 Editor core and multiline composer (+5)

Status: **complete**. The owned editor controller, cell-bounded composer,
bracketed-paste path, async submission revision guard, history/undo limits,
fixed-size snapshots, interactive input fixture, clean-tarball PTY flow, and
100,000-code-unit benchmark are implemented.

Implementation:

- add a pure `EditorController` with Unicode cursor/selection operations,
  bounded undo/redo, multiline text, preferred column, and history traversal;
- add bracketed-paste decoding and batch insertion at the terminal adapter;
- preserve drafts on rejected/failed submission and reset only after accepted
  ownership transfer;
- render cursor and multiline viewport within a bounded composer height;
- retain current followup, steer, cancel, and modal precedence.

Verification:

- table/property tests for editing operations and Unicode boundaries;
- fixed 80×24 and 40×16 composer snapshots;
- PTY multiline paste, edit, submit, cancel, and teardown cases;
- memory tests for history/undo/input limits.

### M1.2 Transcript viewport and search (+4)

Status: **complete**. The owned viewport, bounded retained-window search, stable
focus, navigation/unseen state, tool-card fold and bounded detail paging,
visible plain-text OSC 52 copy, fixed-size snapshots, interactive PTY flow, and
10,000-row benchmark are implemented.

Implementation:

- add a pure viewport controller with follow-tail, line/page jumps, stable row
  focus, unseen count, and eviction awareness;
- add bounded search with next/previous match;
- add per-card fold/expand state keyed by durable call row id;
- add a bounded plain-text projection and explicit OSC 52 copy request in the
  adapter. Safe OSC 8 file links remain in M5.3 with attachments/IDE links.

Verification:

- replay/live additions while following and while scrolled away;
- search across Unicode, truncated cards, and evicted windows;
- resize snapshots and PTY navigation tests;
- 10,000-row benchmark remains inside the bounded rendering budget.

### M1.3 Overlay system, command palette, and completion (+3)

Status: **complete**. Exclusive overlay focus, live exact-agent command
discovery, bounded deterministic fuzzy ranking, discoverable local actions,
generation-safe command/workspace completion, narrow/wide snapshots, command
failure/cancellation routing, and clean-package PTY flows are implemented.

Implementation:

- introduce a framework-neutral overlay/focus state machine;
- project Harness command metadata and local navigation actions into one fuzzy
  palette without duplicating command execution;
- add abortable, generation-checked command/path completion;
- make every action discoverable when a terminal cannot emit its shortcut.

Verification:

- focus precedence and stale-completion tests;
- command argument/error/cancellation integration tests;
- narrow/wide palette snapshots and keystroke PTY flow.

### M1.4 Session center and attachment transitions (+4)

Status: **complete**. Bounded persisted-session discovery, metadata filtering,
durable preview, exact-session resume, input-blocking attachment transitions,
preflight recovery, and fail-closed teardown are implemented.

Implementation:

- consume session-persistence metadata through a runtime adapter;
- add bounded list, filter, preview, resume, and capability-gated actions;
- refactor one-shot attachment into an owned session coordinator that can
  quiesce and replace an attachment without leaking listeners or handles;
- surface switch failure with deterministic recovery.

Verification:

- list/inspect abort and corruption fixtures;
- exact-handle disposal and no-overlap transition tests;
- fresh → session A → session B → exit PTY path;
- resume meaning remains equivalent to durable replay.

### M1.5 Status, model, permission entry points, and preferences shell (+4)

Status: **complete**. Exact startup model resolution, durable runtime-status
projection, width-prioritized metadata, permission-command discovery, and an
atomically validated process-local preference/keymap shell are implemented.

Implementation:

- add immutable status projections for model, permission, usage/context
  availability, branch/workspace, viewport, and background state;
- add model selection before new-session creation using the public model
  registry/default-selection seams;
- add the preference schema and default theme/keymap command bindings;
- keep dangerous permission mutation for M2.1.

Verification:

- missing/late service projection tests;
- model choice applied to the newly created exact agent;
- status degradation snapshots at 120, 80, and 40 columns;
- invalid preference fallback and collision tests.

M1 exit gate:

- a clean-profile user can compose multiline prompts, navigate/search history,
  discover commands, browse/resume sessions, choose a model, and understand
  current state entirely from the terminal;
- total progress becomes **45%** only after all five pushed slices and blocking
  CI runs pass.

## M2 — Safety & Recovery (45% → 62%)

### M2.1 Permission presets and sandbox visibility (+5)

Status: **complete**. The exact-session permission panel projects public preset
metadata and consequences, applies safe modes through the owning service, and
requires a full typed phrase before unrestricted access. Missing services,
write failures, external changes, cancellation, and bounded catalogs are
fail-closed.

- adapt the public permission-preset service;
- preview sandbox/approval consequences;
- apply safe modes atomically and require typed/explicit confirmation for
  danger-full-access;
- test unavailable services, failed transitions, concurrent changes, and exact
  agent scoping.

### M2.2 Change index and review workbench (+5)

Status: **complete**. Durable call/result events are replayed through the exact
tool's public presentation functions into a bounded, framework-neutral change
index. The review overlay groups repeated edits by file, distinguishes planned,
applied, failed, and unverified results, expands bounded diff detail, jumps to a
retained transcript row, and adds exact-call planned-file context to approval
prompts. Presenter and index failures remain non-authoritative and contained.

- index durable diff intents by tool call and file without reading hidden tool
  state;
- provide file grouping, jump-to-event, folded/unfolded diff, truncation, and
  pre-execution approval context;
- test parallel calls, repeated file edits, malformed diffs, and bounded index
  retention.

### M2.3 Durable recovery and capability-gated rewind (+5)

Status: **complete**. The Recovery workbench exposes an exact-session durability
barrier, capability-gated raw export with atomic no-overwrite publication, and
an explicitly confirmed conversation-only fork. Forking transfers a frozen
durable seed and parent lineage through public agent creation while the session
coordinator preserves no-overlap ownership and parent restoration. File rewind
is visibly unavailable on rc.6; no diff is reverse-applied.

- expose session durability, export, fork, and checkpoint capabilities as
  separate operations;
- implement conversation fork only through a public lineage/session seam;
- adapt public file rewind when the compatibility baseline provides one;
- on rc.6, show a tested unavailable state and never reverse arbitrary diffs or
  claim Bash writes are recoverable.

### M2.4 Failure recovery matrix (+2)

Status: **complete**. Stable failure IDs inject every required boundary.
Recoverable failures retain an exact usable attachment and retry path; fatal
projection, render, and output failures drain ownership and request clean
non-zero exit. Reverse-order teardown continues after independent failures and
preserves the primary error ahead of labelled cleanup causes.

- inject failures during editor submission, session switch, projection refresh,
  permission change, export, render, output closure, and disposal;
- guarantee either a usable attached session or clean process exit;
- aggregate cleanup errors without suppressing the primary failure.

M2 exit gate:

- every authority escalation is explicit and every supported recovery operation
  states its exact boundary;
- total progress becomes **62%** after four pushed slices and green CI.

## M3 — Orchestration (62% → 78%)

### M3.1 Projection hub: todo, goal, plan, usage (+4)

Status: **complete**. One owned projection subscription publishes immutable
plan, todo, goal, usage, and bounded diagnostic snapshots behind a single
overlay. Usage accounting moved out of `RuntimeStatusController` so no second
event-folding truth competes with the registered projection values. Missing
projections, malformed values, and disposal are tested states.

- add one projection subscription owner with immutable snapshots and bounded
  diagnostics;
- implement plan/todo/goal/usage panels from registered projection values;
- prove no second event-folding truth is introduced.

### M3.2 Background jobs (+4)

Status: **complete**. The job panel projects the bounded visible set, ownership,
lifecycle status, and bounded completion notices from `ctx.jobs`, and cancels
owned live work behind a two-step confirmation. Output is reported as
unavailable rather than consumed: the registry's only output seam advances the
job's read cursor and marks the record reported, which would suppress the
owning agent's completion notice ([ADR-0006](decisions/0006-observe-background-jobs-without-consuming-them.md)).
Selection is anchored to a job id, and completion, cancellation, refresh, and
disposal races are tested.

- adapt jobs list/status/output/control operations;
- add attach/detach, bounded log tail, cancel confirmation, and completion
  notices;
- test races between completion, cancellation, refresh, and disposal.

### M3.3 Subagent tree and controls (+5)

Status: **complete**. `listDescendants` is projected into a stable pre-order
tree carrying durable lineage, depth, mode, activity, and per-child
diagnostics; enumeration loads and resumes no Agent. Controls stay on public
seams: `interrupt()` under this session's human parent address, `followup()`
only for direct continuable children — deeper descendants fail closed because
delivery requires the exact live direct parent, which this session is not —
and attachment is delegated to the session coordinator by id. Listings are
generation-guarded so a late one cannot overwrite fresher rows, selection and
follow-up drafts are anchored to session ids, and parallel children,
disappearing agents, unread updates, root switch, and disposal are tested.

- project lineage/status into a stable tree;
- expose only public message/follow-up/interrupt/cancel/attach controls;
- retain exact-agent approval/question isolation;
- test parallel children, disappearing agents, unread updates, and root switch.

### M3.4 Unified activity center (+3)

- combine plans, jobs, and agents into bounded notifications and navigation;
- add command-palette actions and status counts;
- test notification coalescing and no update-after-disposal behavior.

M3 exit gate:

- a user can inspect and control every publicly observable local activity
  without leaving the TUI;
- total progress becomes **78%** after four pushed slices and green CI.

## M4 — Extension Workbench (78% → 90%)

### M4.1 Versioned preferences, themes, and keymaps (+3)

- persist the TUI settings namespace through the public settings service when
  writable, with safe process-only fallback otherwise;
- add semantic color themes, no-color/reduced-motion modes, binding overrides,
  and atomic validation;
- snapshot all semantic states in color and no-color modes.

### M4.2 Skills and hooks (+3)

- add abortable skill catalog discovery, completeness/error state, details, and
  explicit invocation insertion;
- show hook providers/configuration and observable failures through public
  inventory only;
- never execute a hook merely to test it.

### M4.3 MCP inventory and health (+3)

- group MCP-qualified tools by server and expose public connection health when
  available;
- redact headers/env/secrets and distinguish configured, connecting, active,
  degraded, and unavailable when the service provides these states;
- test reconnect invalidation and stale inventory generations.

### M4.4 Plugin inventory and diagnostics (+3)

- consume the public plugin-inventory/loader projection;
- show enabled state, fiber phase, module, and bounded failure diagnostics;
- enable mutation only if an owning loader/settings transaction is public;
- test HMR/disposal invalidation without importing plugin implementation files.

M4 exit gate:

- installed capabilities and configuration are discoverable, safely redacted,
  and diagnosable from the terminal;
- total progress becomes **90%** after four pushed slices and green CI.

## M5 — Productization (90% → 100%)

### M5.1 Non-interactive runner and output contracts (+3)

- extend startup with `--print`, `--output-format text|json|stream-json`, and
  piped prompt handling;
- share runtime controllers without mounting terminal state;
- version JSON envelopes, preserve event order, separate stdout/stderr, handle
  backpressure, and fail closed on invisible human interaction;
- add golden contract tests and pipe/exit-code integration tests.

### M5.2 Diagnostics, onboarding, and accessibility (+3)

- implement read-only `--doctor` and actionable service/model/persistence/TTY
  checks with redaction;
- add first-run guidance, no-color, reduced-motion, keyboard-only operation,
  and screen-reader-oriented text mode;
- add clean-profile broken-configuration fixtures.

### M5.3 Attachments and terminal/IDE links (+2)

- consume the public attachment seam for image/file inputs;
- negotiate terminal image support and retain a textual fallback;
- generate safe OSC 8 file links without shell interpolation;
- test unsupported terminals, missing attachments, size limits, and replay.

### M5.4 Worktrees and remote readiness (+2)

- add capability-gated worktree/session filtering and launcher-owned workspace
  transitions;
- keep remote mode out of the local runtime until a second concrete transport
  exists;
- if remote is implemented, first add an ADR covering auth, negotiation,
  reconnect, ordering, and exact-agent human interaction routing.

M5 exit gate:

- interactive and non-interactive clean-profile acceptance suites pass on the
  blocking platform matrix;
- documentation, package contents, diagnostics, accessibility paths, and
  supported capability limitations match actual behavior;
- total progress becomes **100%** only after final production review, fixes,
  push, and green CI.

## Commit, CI, and rollback protocol

For each slice:

1. Implement one complete vertical path and its failure/unavailable states.
2. Run focused tests while developing.
3. Run `pnpm check`; run package/PTY/benchmark gates proportional to the
   changed boundary.
4. Review the diff for correctness, security, bounds, cancellation, ownership,
   public imports, and documentation truth.
5. Fix every finding, commit with a slice-scoped message, and push `main`.
6. Wait for blocking CI. A red run leaves the slice incomplete; fix, commit,
   push, and repeat.

Changes are additive and independently revertible. Persisted session formats
are never rewritten. Preference schema migrations retain the previous valid
document and support downgrade. New entry-point flags remain backward
compatible. A failed release can be deprecated while users pin the last green
release candidate.

## Final completion audit

Before declaring 100%, inspect evidence for every M1–M5 slice rather than
inferring completion from a green aggregate command. The audit records:

- source module and public service implementing each requirement;
- deterministic test or snapshot proving the normal path;
- test proving cancellation, unavailable capability, and disposal;
- clean-package/PTY evidence where applicable;
- pushed commit and blocking CI run;
- residual upstream limitations, especially file rewind and remote transport.

Any missing or indirect evidence keeps the objective active.
