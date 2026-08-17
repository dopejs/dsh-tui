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

All milestones are complete; see the [final completion audit](#final-completion-audit).

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

Status: **complete**. One derived aggregator folds the plan, job, and subagent
snapshots into a bounded, coalesced notification list, status counts, and
navigation that opens the panel answering each notification. It owns no domain
state, so a notification cannot disagree with the panel it navigates to. A
still-true activity re-fires as a count bump rather than a new row, overflow is
counted rather than silently dropped, and every source is unsubscribed on
disposal with no update after it.

- combine plans, jobs, and agents into bounded notifications and navigation;
- add command-palette actions and status counts;
- test notification coalescing and no update-after-disposal behavior.

M3 exit gate:

- a user can inspect and control every publicly observable local activity
  without leaving the TUI;
- total progress becomes **78%** after four pushed slices and green CI.

Status: **complete**. All four slices are pushed. Two capability boundaries are
carried forward rather than papered over: job output stays with the owning
agent ([ADR-0006](decisions/0006-observe-background-jobs-without-consuming-them.md)),
and subagent follow-up reaches only this session's direct children.

## M4 — Extension Workbench (78% → 90%)

### M4.1 Versioned preferences, themes, and keymaps (+3)

Status: **complete**. The `dsh-tui` namespace registers a schema through
`ctx.settings` and persists there when a writable provider exists; an absent or
read-only provider is reported as process-only rather than accepting edits that
would be dropped at exit. Panels name semantic tones instead of colors, so the
default, high-contrast, and no-color themes are answered in one place, and a
test asserts the rendered text is identical with and without color — no
information is carried by color alone. Reduced motion and keymap overrides are
part of the same document, validation is all-or-nothing, and an externally
edited document that fails it keeps the last good value and warns.

- persist the TUI settings namespace through the public settings service when
  writable, with safe process-only fallback otherwise;
- add semantic color themes, no-color/reduced-motion modes, binding overrides,
  and atomic validation;
- snapshot all semantic states in color and no-color modes.

### M4.2 Skills and hooks (+3)

Status: **complete**. Skill discovery runs through `ctx.skills.snapshot()` with
the viewing scope, cwd, and an abort signal; a stale run cannot overwrite a
fresher one, and an incomplete observation is shown as partial rather than
cached as authoritative. Details load a skill body for reading, which is a read
and not an invocation, and the panel only inserts `/name` into the composer for
a user-invocable skill — the user still submits it.

Hooks have no public inventory on this baseline: `dsh-base` mounts no hook
service and no package owns one. The panel says so. Building one would require
reading private configuration or running a hook to observe it, and the second
has side effects the user did not ask for, so nothing is executed to test it.

- add abortable skill catalog discovery, completeness/error state, details, and
  explicit invocation insertion;
- show hook providers/configuration and observable failures through public
  inventory only;
- never execute a hook merely to test it.

### M4.3 MCP inventory and health (+3)

Status: **complete**. MCP-bridged tools are grouped by server using the
documented public name grammar (`mcp__<server>__<raw>`), read from the
model-facing `ctx.tools.schemas()` projection — which carries no transport
object, header map, or environment, so there is nothing to redact and no
credential is reachable. Names that do not match the grammar are counted as
plain tools rather than guessed at.

Connection health is reported as unavailable: `dsh-mcp-client` owns its
connection privately and the baseline publishes no health registry, so
configured/connecting/degraded would be inferred from a tool list that says
nothing about the transport. The registry's `tools/change` event drives
invalidation, and the inventory is rebuilt rather than patched, so a reconnect
cannot leave rows from the previous connection behind.

- group MCP-qualified tools by server and expose public connection health when
  available;
- redact headers/env/secrets and distinguish configured, connecting, active,
  degraded, and unavailable when the service provides these states;
- test reconnect invalidation and stale inventory generations.

### M4.4 Plugin inventory and diagnostics (+3)

Status: **complete**. The panel consumes the public
`PluginInventorySnapshot` contract — enabled state, fiber phase, module
specifier — and reports a failed fiber as a diagnostic without inventing a
cause the Loader does not publish. An unrecognized phase from a newer Loader is
preserved verbatim rather than collapsed into one that means something else,
and the rows are rebuilt on invalidation so an HMR swap or disposal cannot
leave a stale entry behind. No plugin implementation file is imported.

Two boundaries are reported rather than worked around. Mutation is unavailable:
enabling an entry means writing the Loader tree or the profile document, and
neither is a public transaction here, so a toggle would let the running fiber
and the stored configuration disagree with no owner to reconcile them. And on
rc.6 the projection is published only as a Typert *remote* gateway with no
Cordis context service, so an in-process consumer cannot reach it at all — the
controller is constructed without a source and the panel says so. It gains a
real inventory the moment a public in-process seam exists.

- consume the public plugin-inventory/loader projection;
- show enabled state, fiber phase, module, and bounded failure diagnostics;
- enable mutation only if an owning loader/settings transaction is public;
- test HMR/disposal invalidation without importing plugin implementation files.

M4 exit gate:

- installed capabilities and configuration are discoverable, safely redacted,
  and diagnosable from the terminal;
- total progress becomes **90%** after four pushed slices and green CI.

Status: **complete**. All four slices are pushed. Three capability boundaries
are reported rather than fabricated: hooks have no public inventory, MCP
publishes no connection-health registry, and the plugin projection is
remote-only with no public enablement transaction.

## M5 — Productization (90% → 100%)

### M5.1 Non-interactive runner and output contracts (+3)

Status: **complete**. `--print` runs one prompt with no terminal state mounted
and is routed before the TTY requirement, so it works on a pipe and in CI; the
prompt comes from the argument or from a bounded stdin read, and an empty pipe
is distinguished from an empty prompt. `--output-format` selects `text`
(default), `json`, or `stream-json`, and is refused without `--print` rather
than promising a contract the interactive runtime never emits.

Envelopes carry a schema version, are emitted in durable event order, and skip
unknown or malformed events instead of guessing. Encoding is pure and
synchronous while writes are chained and backpressure-aware, so a slow pipe
cannot reorder output or buffer the whole run. stdout carries only run output
and stderr only diagnostics, so redirecting one never loses the other.

Human interaction fails closed: with no terminal to prompt on, approvals are
rejected and questions refused, and the run exits `interaction-required` (2) —
its own code, because a caller retrying it unchanged hits the same wall.

- extend startup with `--print`, `--output-format text|json|stream-json`, and
  piped prompt handling;
- share runtime controllers without mounting terminal state;
- version JSON envelopes, preserve event order, separate stdout/stderr, handle
  backpressure, and fail closed on invisible human interaction;
- add golden contract tests and pipe/exit-code integration tests.

### M5.2 Diagnostics, onboarding, and accessibility (+3)

Status: **complete**. `--doctor` diagnoses required and optional services, the
model selector, session persistence, and the TTY, and gives each finding an
actionable remedy. It is read-only — no session starts, no agent is created, no
tool runs — because a diagnostic that changed what it diagnosed would be worse
than none, and a wedged persistence backend is bounded by a timeout rather than
hanging the diagnosis that would explain it. Redaction is structural: only
environment variable *names* are compared and reported, never values, because
this output is what users paste into issue trackers. `--doctor` and `--print`
are mutually exclusive, and only `fail` exits non-zero.

Accessibility is carried by the preference document: no-color, high-contrast,
reduced motion, and a screen-reader mode that drops box drawing — a screen
reader announces border glyphs as content, so a bordered panel reads as noise
around the text the user asked for. A test asserts the plain frame loses no
text. Operation is keyboard-only and every action stays discoverable in the
command palette, so a terminal that cannot emit a chord can still reach it.
First-run guidance points at the palette, since a new user has no other way to
discover the panels yet.

- implement read-only `--doctor` and actionable service/model/persistence/TTY
  checks with redaction;
- add first-run guidance, no-color, reduced-motion, keyboard-only operation,
  and screen-reader-oriented text mode;
- add clean-profile broken-configuration fixtures.

### M5.3 Attachments and terminal/IDE links (+2)

Status: **complete**. Images go through the public attachment seam:
`validateImage` runs before `saveImage`, so a refused file writes nothing, and
every size and format bound is the store's published `imageLimits` rather than
a number guessed here. The declared media type is only a proposal — the store
verifies it against the decoded bytes — and the display name is stripped of
directory components so the user's layout does not leak into durable session
data.

Terminal support is negotiated before anything is written, with inline images
and hyperlinks treated as separate capabilities. Every attachment also has a
one-line textual description, so an unsupported terminal shows less, never
nothing. OSC 8 links are built with `pathToFileURL`, and any path or label
carrying a C0/C1 control byte is refused outright: ESC or BEL inside an OSC
payload would terminate the sequence early and let the remainder be read as
terminal commands. Nothing here is passed to a shell.

- consume the public attachment seam for image/file inputs;
- negotiate terminal image support and retain a textual fallback;
- generate safe OSC 8 file links without shell interpolation;
- test unsupported terminals, missing attachments, size limits, and replay.

### M5.4 Worktrees and remote readiness (+2)

Status: **complete**. Sessions are grouped and filtered by the durable header
`cwd` — the only workspace fact a session actually carries — with labels
shortened to the last path segment only while that stays unambiguous, since two
worktrees of one repository share a leaf name. Nothing is inferred from the
filesystem, because a recorded cwd may no longer exist, and a session with no
recorded workspace is excluded from a narrowed list rather than quietly
included.

Workspace transitions are reported as launcher-owned: the TUI runs inside an
already-composed process and cannot re-root it without invalidating every live
handle, so the user is told which root to relaunch from. Remote attachment
stays out of the local runtime until a second concrete transport exists
([ADR-0007](decisions/0007-defer-remote-attachment-until-a-second-transport.md)).

- add capability-gated worktree/session filtering and launcher-owned workspace
  transitions;
- keep remote mode out of the local runtime until a second concrete transport
  exists;
- if remote is implemented, first add an ADR covering auth, negotiation,
  reconnect, ordering, and exact-agent human interaction routing.

M5 exit gate:

Status: **complete**. All four slices are pushed.

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

Completed 2026-08-17 at `8f8ecc2`, CI run `31988237634` green on
ubuntu-latest (Node 22.19.0 and 24.x), macos-latest, and windows-latest.
Total progress: **100%**.

Evidence was inspected per slice rather than inferred from a green aggregate.

### Implementation and proof

Every model and runtime module has a direct test module; the suite is 55 files
and 505 tests, plus fixed-size overlay and frame snapshots at 40, 64, 72, and
80 columns, an interactive PTY flow covering the palette and every panel, a
clean-profile tarball install (`pnpm test:package`), and bounded-budget
benchmarks for the 100,000-code-unit editor and the 10,000-row viewport.

Each capability-gated panel carries three tests beyond its normal path: the
service being absent, an operation failing or being cancelled, and disposal
with no update afterwards. The failure-recovery matrix injects each stable
failure id and asserts either a usable attachment or a clean non-zero exit.

### Public services consumed

`ctx.agents`, `ctx.sessions`, `ctx.sessionPersistence`, `ctx.commands`,
`ctx.tools`, `ctx.llm`, `ctx.agentDefaultModel`, `ctx.permissionPresets`,
`ctx.userQuestions`, the `approval/request` waterfall, `ctx.sessionProjections`,
`ctx.jobs`, `ctx.subagents`, `ctx.skills`, `ctx.settings`, and
`ctx.attachments` — root package exports only, enumerated in
[Upstream compatibility](upstream-compatibility.md).

### Residual upstream limitations

These are reported in the product as absent capabilities, each with a test that
asserts the absence rather than a guess:

- **File rewind** — no public checkpoint owner; no diff is reverse-applied
  ([ADR-0005](decisions/0005-separate-conversation-recovery-from-file-rewind.md)).
- **Background job output** — the only output seam consumes the read cursor and
  suppresses the owning agent's completion notice
  ([ADR-0006](decisions/0006-observe-background-jobs-without-consuming-them.md)).
- **Subagent follow-up beyond depth 1** — delivery requires the exact live
  direct parent, which this session is not for deeper descendants.
- **Hooks** — no public inventory service exists on the baseline.
- **MCP connection health** — no health registry; a tool list says nothing
  about the transport.
- **Plugin inventory and enablement** — published only as a Typert remote
  gateway with no Cordis context service, and no public transaction owns
  enablement.
- **Remote attachment** — deferred until a second concrete transport exists
  ([ADR-0007](decisions/0007-defer-remote-attachment-until-a-second-transport.md)).
- **Worktree enumeration** — no service; workspaces are derived from durable
  session `cwd`, and workspace transitions stay launcher-owned.

### Escapes found and fixed during the audit

Four defects reached `main` before being caught, each because the local gate did
not cover the surface it broke:

1. **Unpublished bundler chunks.** Sharing a module between the `index` and
   `startup` entry points produced a content-hashed chunk that the `files` list
   did not name, so the published package imported a module absent from the
   tarball. `pnpm check` passed throughout because it runs against the untrimmed
   working tree. Fixed in `ae35079`, and `pnpm check:package` now asserts every
   emitted artifact is covered; the guard was verified against the exact
   regression.
2. **A platform-dependent test.** An OSC 8 assertion hardcoded a POSIX file URL
   and failed only on the Windows runner. Fixed in `8f8ecc2` by asserting the
   escaping and wrapping under test instead of the host's notion of an absolute
   path.

3. **Capabilities built but wired to nothing.** The attachments controller, the
   terminal-link renderer, and workspace filtering were implemented, unit
   tested, and recorded here as complete while no runtime constructed them and
   no view rendered them — so none was reachable by a user. `tsc`, eslint, and
   the unit suites were all satisfied by each module plus its own test. Fixed by
   adding the attachments panel, rendering change paths as OSC 8 links, and
   giving the session center a workspace cycle; `pnpm check:wiring` now fails
   when a module is imported only by test files.

   The same sweep found `src/runtime/agent-runtime.ts`, a superseded
   composition helper that only its own test used — the runtime composes
   `createRuntimePlugin` and `attachAgent` directly — and it was deleted; its
   behaviour is covered by `cordis-runtime.test.ts`, `agent-attachment.test.ts`,
   and `index.test.ts`. `src/cli.tsx` was flagged too but is **not** dead: the
   PTY suite spawns it as a subprocess, which is the only evidence for
   M2.4-F06 and M2.4-F07. The guard now counts a path reference as wiring
   rather than relying on an allowlist, so a subprocess entry point stays
   protected without being exempt.
4. **An assertion that could not fail.** A malformed regular expression made a
   doctor-output check vacuous. It now asserts no ANSI and no box drawing,
   verified by mutation.

The first two were found by CI, the third by an explicit reachability sweep
during this audit, and the fourth by reading the assertion. Each now has a
guard that reproduces it.
