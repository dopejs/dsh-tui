# Testing strategy

## Objectives

Testing must prove semantic correctness, resource cleanup, deterministic visual
output, compatibility with Harness public contracts, and safe behavior under
cancellation. Browser component tests are not evidence for the TUI.

The full M1–M5 acceptance contract is defined in
[Product design](product-design.md) and [Implementation plan](implementation-plan.md).
Every feature test is tagged in its description with the milestone slice it
proves so the final audit can map requirements to executable evidence.

## Test layers

### Pure reducer tests

Feed ordered `SessionEvent` fixtures into the transcript reducer and compare the
entire view model.

Required cases:

- user/assistant text and mixed content blocks;
- multiple assistant chunks followed by one final anchor;
- chunkless final assistant messages;
- tool call/result correlation, errors, and cancellation synthesis;
- parallel calls whose durable results remain model ordered;
- compaction/surface replacement without erasing human-visible history;
- duplicate event sequence, sequence gap diagnostics, and late registration;
- unknown ignorable events and unsupported required events;
- bounded output and transcript-window eviction.

Property tests may generate valid event prefixes once the basic reducer is
stable. They should check idempotence by sequence and equivalence between one-shot
folding and arbitrary replay/live partitions.

Framework-neutral editor, viewport, overlay, palette, preference, projection,
and activity controllers receive the same treatment. Generated editor
operation sequences must preserve valid cursor/selection bounds and undo/redo
round trips. Async search/catalog tests use injected settlement rather than
wall-clock sleeps and prove stale generations cannot publish.

Workspace completion fixtures use temporary directories and prove realpath
containment, hidden-file policy, missing paths, cancellation, and deterministic
ranking without reading outside the fixture root.

### Presenter contract tests

Use real tool presentation types and fixture definitions to verify:

- every known intent maps to a framework-neutral TUI model;
- missing tools and `undefined` presenters use generic fallback;
- presenter exceptions are contained;
- a missing result presenter keeps durable raw result content visible;
- relative cwd/path handling uses session workspace metadata;
- truncated search/read/output state is visible;
- model-facing content is never rewritten by presentation.

### Controller and lifecycle tests

Use fixture Cordis services and fake agents to test:

- loader settlement precedes create/resume;
- the exact returned handle is disposed once;
- listeners and providers unregister before late callbacks can update UI;
- follow-up, steering, command, and cancellation route correctly;
- unresolved slash commands never enter either agent inbox and concurrent
  commands are refused until the owned request settles;
- `whenIdle()` is treated as whole-agent quiescence;
- question and approval aborts settle their promises;
- modal work is serialized and bounded, and invalid question answers are rejected;
- a request for another agent is delegated or refused, never displayed as the
  current agent's decision.

### Snapshot tests

Render at fixed terminal widths and heights with deterministic color capability,
time, paths, ids, and Unicode settings. Snapshots cover:

- empty screen and help;
- streaming/final assistant message;
- generic, terminal, diff, read, search, and Web cards;
- approval and question modals;
- queued input and cancellation;
- transcript focus, eviction/unseen state, search, and folded/expanded tools;
- narrow/full-screen and wide palette plus completion loading/result states;
- narrow terminal wrapping and resize;
- errors, truncation, and unsupported content fallback.

Snapshots are reviewed artifacts, not assertions that rendering did not crash.

### Pseudo-terminal tests

Spawn the built entry point in a real PTY and inspect terminal state/output.

Required paths:

- normal quit;
- startup failure after raw mode acquisition;
- SIGINT and SIGTERM during idle, streaming, tool execution, approval, and
  question prompts;
- terminal resize while output streams;
- EOF and closed output;
- repeated cancellation;
- multiline paste and transcript search/navigation input ownership;
- non-TTY stdin/stdout refusal;
- no orphan process or open handle after exit.

Terminal cleanup assertions must verify raw/canonical mode and alternate-screen
exit, not merely process exit status.

### Harness integration tests

Boot a minimal profile against a pinned Harness build with deterministic model
and tool fixtures. Exercise public entry paths:

- fresh create and resume;
- durable replay/live handoff;
- model-selected agent setup;
- known and unknown slash commands;
- approval allow/reject/cancel/unavailable;
- user-question single/multi/custom/plan-review;
- persistence flush and disposal failure reporting.

No network API key is required for blocking CI. A separately gated smoke test
may use a real DeepSeek endpoint without becoming the semantic test oracle.

Post-MVP fixtures also cover:

- session list/inspect and exact-handle attachment replacement;
- preflight input blocking, no-overlap A → B switching, old-session recovery,
  and fail-closed double-resume failure;
- exact-session permission writes, missing services, typed dangerous-mode
  confirmation/cancellation, external changes, and failed knob writes;
- parallel and repeated public diff presentations, planned-to-result
  replacement, malformed diff containment, bounded change-index eviction,
  approval context, and retained-row navigation;
- exact-session durability participation, raw-export absence/abort/no-overwrite,
  conversation-fork lineage, no-overlap attachment transfer, parent recovery,
  and explicit rc.6 file-rewind unavailability;
- the stable [M2.4 failure injection matrix](failure-recovery-matrix.md),
  including recoverable submission/switch/permission/export failures, fatal
  projection/render/output failures, and primary-plus-cleanup aggregation;
- model/default selection and permission-preset transitions;
- exact startup-model preflight, 40/80/120-column status degradation, missing
  status facts, and atomic preference collision/fallback behavior;
- projection refresh and missing optional units;
- jobs and subagent list/control races;
- skills, MCP-qualified tools, settings, and plugin inventory invalidation;
- attachment metadata and unavailable checkpoint/worktree capabilities;
- fail-closed non-interactive approval and question behavior.

### Package and install tests

Before publishing:

- build and inspect `pnpm pack` contents;
- install the tarball into a clean temporary `dsh` profile;
- verify bundle discovery and composed config dump;
- start the TUI and complete the deterministic acceptance script;
- confirm no Web/Host/server rows or listening ports are introduced.

The M5 package suite additionally runs piped `text`, `json`, and `stream-json`
commands, validates stdout/stderr separation and exit codes, runs `--doctor`
against valid and broken clean profiles, and verifies no interactive terminal
escape sequence appears in redirected output.

### Contract and accessibility tests

Versioned JSON/NDJSON output uses golden fixtures plus schema validation.
Backpressure fixtures delay writes and prove ordered, lossless termination.
Redaction fixtures seed recognizable secrets in settings, environment maps,
MCP headers, and diagnostics and assert that none reaches rendered or machine
output.

Every interactive action has a keyboard path and a command-palette path.
Snapshots run with color, `NO_COLOR`, narrow terminals, high contrast, reduced
motion, and plain screen-reader text. Color is never the only status marker.

## Platform matrix

| Platform | Blocking coverage |
| --- | --- |
| Linux | Unit, integration, snapshots, PTY, clean install |
| macOS | Unit, snapshots, PTY, signal/restore smoke |
| Windows | Unit, snapshots, terminal adapter and lifecycle paths supported by the chosen framework |

Node versions follow the tested Harness engine range. At minimum, CI covers the
lowest supported Node 22 release and the current supported release line. POSIX
`SIGINT`/`SIGTERM` delivery is asserted on Linux and macOS; Windows asserts
interactive Ctrl-C plus normal and failure cleanup because its pseudo-terminal
process API does not provide equivalent POSIX signal delivery.

## Determinism

Tests inject clocks, ids, workspace paths, model selection, terminal capability,
and dimensions. They normalize platform path separators only at a named boundary.
Timeouts are a last resort; prefer observable state transitions and explicit
settlement signals.

## Performance budgets

The current release-candidate budgets are:

- maximum retained expanded tool output per card: 20,000 UTF-16 code units by
  default, with explicit truncation state;
- maximum number of fully materialized transcript rows: 2,000 by default;
- maximum repaint frequency during chunk streams: one controller notification
  per event-loop turn and no more than the renderer's configured 20 FPS;
- cold replay time for representative long sessions;
- resize/reflow latency for the visible window;
- quiescent shutdown deadline before launcher escalation.
- interactive editor/navigation key-to-frame p95 below 50 ms for the bounded
  visible model;
- at most 200 editor undo entries, history entries, completion candidates,
  session rows, search matches, jobs, agents, or extension rows per view;
- non-interactive stream output honors writable backpressure without reordering
  durable events.

Regressions above a documented budget fail a benchmark smoke gate or require an
explicit decision update.
