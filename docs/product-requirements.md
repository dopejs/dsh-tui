# Product requirements

## Product statement

`dsh-tui` provides a first-class interactive terminal surface for DeepSeek
Harness. It should feel native to terminal workflows while preserving Harness
semantics, plugin composition, safety policy, and durable session history.

The release-candidate MVP targets a developer running `dsh` locally in an
interactive TTY. The production roadmap extends that foundation into a
Claude-Code-class local workflow without copying browser-client internals. The
complete interaction and capability design lives in
[Product design](product-design.md).

## Users and jobs

The primary user is a software engineer who wants to:

- start an agent from the current workspace without opening a browser;
- observe reasoning, assistant output, and tool activity as they stream;
- approve or reject privileged operations safely;
- answer structured questions without breaking the running turn;
- steer, queue, cancel, and resume work using keyboard-first controls;
- leave and later resume a durable session.

## MVP requirements

### Session lifecycle

- Start one new root agent using the deployment's selected default model.
- Resume one persisted session by id.
- Display the active session id, workspace, model, and agent status.
- Dispose the owned agent handle and restore the terminal before exiting.
- Refuse unsupported or non-interactive environments with an actionable error;
  later milestones may add a line-oriented fallback.

### Conversation

- Render existing history and newly committed `session/event` entries as one
  ordered transcript.
- Stream assistant chunks into an in-progress message and reconcile them with
  the final assistant-message anchor without duplicate text.
- Render user messages, assistant messages, tool calls/results, turn errors,
  cancellation, and compaction markers.
- Preserve prior human-visible history when the model-visible surface is
  compacted or replaced.
- Keep memory bounded for long sessions and large tool output.

### Input and control

- Submit ordinary prompts with `agent.followup()`.
- Offer an explicit steering gesture using `agent.steer()`.
- Execute known slash commands through `ctx.commands`; reject unknown slash
  commands rather than forwarding them to the model.
- Cancel active work with `agent.cancel({ kind: 'user' })`.
- Prevent simultaneous terminal readers from consuming the same keystrokes.

### Tool presentation

- Resolve tool definitions in the active agent scope.
- Render tool-owned call/result presentation intents.
- Provide generic, safe fallbacks when a tool is missing, arguments are stale,
  or a presentation function declines the event.
- Include first-class treatments for terminal, diff, search, read, and Web
  intent families without switching on tool names.

### Human interaction

- Install one terminal approval answerer for the attached root agent.
- Register one user-question provider.
- Support single-select, multi-select, custom answers, descriptions, and
  plan-review intent.
- Honor request abort signals and make agent identity visible in every modal.
- Fail closed if the terminal cannot safely collect a decision.

## Production requirements after MVP

- Provide a Unicode-safe multiline editor with bounded undo/history,
  bracketed paste, completion, and configurable bindings.
- Provide transcript scrolling, search, tool folding, stable navigation, and
  explicit retained-window limits.
- Provide a session center and safe owned transitions between persisted
  sessions.
- Expose command discovery, model selection, permission presets, sandbox state,
  usage/context, and local preferences through their public owning services.
- Provide change review and distinguish durable sessions, conversation forks,
  and file checkpoints without overstating recoverability.
- Render todo, goal, plan, usage, jobs, and subagent state from public Harness
  projections/services.
- Provide skills, hooks, MCP, and plugin inventory with health, redaction, and
  capability-aware mutation.
- Support non-interactive text/JSON/NDJSON operation, diagnostics,
  accessibility, attachments, safe file links, and worktree-aware sessions.
- Keep remote attachment a separately designed mode with a second concrete
  transport and explicit security/reconnect contracts.

## Explicit non-goals for the first release

- Reusing or embedding the React Web client.
- Starting ApiProxy, an HTTP server, or a browser runtime.
- Modifying the default agent loop.
- Supporting several simultaneous human-interaction providers.
- Implementing a second persistence format.
- Matching every Web panel before releasing a useful terminal workflow.
- Inventing a public TUI extension SDK before a second implementation needs it.

## Success criteria

The MVP is ready to publish when:

1. A clean profile can install the bundle, start a new session, complete a tool
   turn, ask for approval, ask a structured question, and exit cleanly.
2. The same session can be resumed with a transcript identical in meaning to the
   previous run.
3. Forced cancellation, plugin disposal, and common process signals leave no
   pending agent, prompt, listener, raw-mode terminal, or alternate screen.
4. Deterministic reducer, lifecycle, snapshot, and pseudo-terminal tests pass on
   Linux, macOS, and Windows-supported paths.
5. The package imports only documented public Harness exports.

## Product risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Harness preview APIs change | Frequent breakage | Pin a tested range and maintain a compatibility matrix. |
| Replay/live handoff races | Missing or duplicate rows | Subscribe first, replay second, and deduplicate by event sequence. |
| Terminal teardown fails | User shell remains corrupted | Central resource owner, `finally` restoration, PTY signal tests. |
| Huge output exhausts memory | TUI freezes or crashes | Bounded view model, folded output, explicit truncation affordances. |
| Approval routed incorrectly | Security boundary violation | Exact live-agent identity checks and one active modal scheduler. |
| Web behavior is copied locally | Semantics drift | Consume core events, projections, commands, and render intents directly. |
