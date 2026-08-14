# Engineering guidance

Treat changes in this repository as production changes.

## Architecture

- Keep DeepSeek Harness behind its documented public package exports and Cordis
  services. Never import `src/*` internals from the upstream repository.
- The durable `session/event` log is the transcript source of truth. Live
  `agent/*` events may enrich status and controls, but must not create a second
  history.
- Keep terminal-framework types inside the rendering adapter. Controllers,
  reducers, and lifecycle logic must remain framework-neutral.
- Prefer existing Harness seams (`commands`, `approval`, `userQuestions`,
  `sessionProjections`, tool presentation intents) over local substitutes.
- Every registration and asynchronous operation must have an explicit owner and
  quiescent disposal path.
- Do not add a remote transport abstraction until a second concrete transport
  is being implemented.

## Change discipline

- Keep the repository install-safe: do not declare `dsh.bundle` or publish the
  package until the first usable vertical slice and its teardown tests pass.
- Update the compatibility document when changing the pinned Harness baseline.
- Record architecture changes as ADRs. Supersede old decisions; do not rewrite
  their history.
- Add deterministic tests for reducers and lifecycle behavior. User-visible
  terminal changes require fixed-size snapshots.
- Run `pnpm check` before committing documentation-only changes. Once runtime
  code exists, run typecheck, unit tests, snapshots, and PTY tests appropriate
  to the change.

## Safety

- Restore terminal raw mode and alternate-screen state in a `finally` path.
- Bound retained tool output, transcript windows, and render queues.
- Honor every Harness-provided `AbortSignal` and await owned work during
  disposal.
- Never route an approval or human question to a different live agent.
