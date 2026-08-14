# Implementation plan

## Delivery principles

- Land vertical slices that can be tested end to end.
- Keep the first publishable change small enough to review; split framework
  scaffolding, transcript semantics, and interaction adapters when needed.
- Do not modify DeepSeek Harness core from this repository.
- When a missing public seam is proven, propose the smallest upstream change
  separately and keep a documented compatibility fallback or minimum version.
- Do not enable `dsh.bundle` or remove `private: true` until Milestone 3 exits.

## Milestone 0 — design baseline

Status: **complete with the initial repository scaffold**.

Deliverables:

- product requirements;
- architecture and accepted ADRs;
- implementation and test plans;
- compatibility policy;
- documentation link validation and CI.

Exit criteria:

- local documentation check passes;
- repository has a protected, reviewable `main` baseline;
- open questions are explicit rather than hidden in implementation.

## Milestone 1 — framework spike and lifecycle shell

Goal: prove terminal ownership and Cordis application startup without driving a
model turn.

Work:

- evaluate terminal frameworks using ADR-0003 criteria;
- select and record the framework/version;
- add TypeScript build, typecheck, unit-test, and lint gates;
- implement `tui-startup` parsing for `--help` and `--resume`;
- implement raw mode, alternate screen, resize, and deterministic shutdown;
- mount a runtime plugin over a fixture Cordis context;
- render an empty screen and exit through normal and signal paths.

Exit criteria:

- PTY tests prove terminal restoration after normal exit, startup failure,
  SIGINT, and SIGTERM;
- the renderer does not leak framework types into lifecycle or domain modules;
- no agent or Harness package internals are imported.

## Milestone 2 — durable transcript vertical slice

Goal: create or resume one agent and render a correct text/tool transcript.

Work:

- wait for loader settlement and install model selection;
- own `AgentHandle` from `create()` or `resume()`;
- implement listener-first replay/live attachment with sequence deduplication;
- fold user, assistant chunks/messages, turns, errors, tool calls/results;
- implement generic and terminal tool-intent renderers;
- add ordinary follow-up, explicit steering, cancellation, and busy status;
- add bounded transcript window and repaint coalescing.

Exit criteria:

- a keyless fixture completes a multi-step tool turn;
- replay and live execution produce equivalent snapshots;
- assistant chunk/final reconciliation never duplicates content;
- long-output tests remain within defined memory/render budgets;
- agent disposal reaches quiescence.

## Milestone 3 — safe interactive MVP

Goal: cover every human-blocking seam and become installable.

Work:

- integrate `ctx.commands`, discovery, and command results;
- add approval answerer with exact-agent routing;
- add user-question provider including plan review;
- implement remaining tool-intent families and generic fallbacks;
- add session id/model/workspace/status chrome;
- add installation smoke test against a clean `dsh` profile;
- declare `dsh.bundle`, add `cordis.patch.yml`, export built artifacts, and remove
  `private: true` only after release review.

Exit criteria:

- complete acceptance flow: install, create, tool call, approve, answer,
  command, cancel, exit, resume;
- all abort and teardown tests pass;
- package tarball contains only intended runtime files and bundle patch;
- README installation instructions work from a clean environment;
- compatibility matrix names an exact supported Harness release/range.

## Milestone 4 — rich local workflow

Potential scope, prioritized by user evidence:

- session list and picker via persistence metadata;
- model and permission selection;
- diff, search, read, and Web presentation polish;
- projection-backed todo, goal, usage, and subagent views;
- configurable key bindings and themes;
- session export and diagnostics.

Each feature must use the owning Harness seam. If it needs TUI-specific
rendering, begin with an internal keyed renderer table.

## Milestone 5 — ecosystem and upstreaming

After at least one release is used in real projects:

- document missing or unstable upstream contracts with reproductions;
- submit narrow DeepSeek Harness PRs where public seams are insufficient;
- decide whether a public `dsh-tui-api` renderer registry has at least two real
  providers/consumers;
- propose official listing, recommended community status, or migration into the
  DeepSeek Harness monorepo;
- separately scope remote-client mode if users require attachment to an existing
  Harness process.

## Initial issue breakdown

Suggested review-sized issues:

1. Terminal-framework benchmark and ADR update.
2. TypeScript/build/test scaffold.
3. Runtime owner and terminal restoration tests.
4. Startup argument provider.
5. Agent create/resume ownership fixture.
6. Replay/live event attachment and sequence reducer.
7. Assistant-stream reconciliation.
8. Generic and terminal tool presentation.
9. Input routing and slash commands.
10. Approval scheduler and tests.
11. User-question provider and tests.
12. Bundle packaging and clean-profile smoke test.

## Release and rollback

Pre-1.0 releases should use explicit release candidates and a tested Harness
peer range. Publishing a broken bundle can be rolled back by deprecating the npm
version and instructing profiles to pin the last known-good release; user
profiles remain independently patchable. No release should require rewriting
stored session logs.
