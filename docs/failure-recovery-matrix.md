# Failure recovery matrix

This matrix is the executable acceptance contract for M2.4. A recoverable
failure must leave the current exact session attached and accepting input. An
unrecoverable failure must stop input, dispose every owned operation and exact
`AgentHandle`, restore terminal state on a best-effort basis, and request a
non-zero launcher exit. No path may silently continue without either
postcondition.

| ID | Injected boundary | Required outcome | Automated evidence |
| --- | --- | --- | --- |
| M2.4-F01 | Message follow-up/steer or slash-command submission rejects | Return a structured error, keep the exact editor revision and attached session usable; a later edit or retry remains possible. | `src/runtime/input-controller.test.ts`, `src/ui/app.input.test.tsx` |
| M2.4-F02 | Session preflight, target attach, or child creation rejects | Reopen the parent input gate before disposal, or recreate the persisted parent after disposal. If neither target nor parent can attach, request fatal exit; never overlap handles. | `src/runtime/session-attachment-coordinator.test.ts`, `src/index.test.ts` |
| M2.4-F03 | A durable-event projection rejects during live refresh | Stop that event pump, report once, stop input, and cleanly dispose the exact attachment before launcher exit. Durable `session/event` history remains authoritative. | `src/runtime/agent-attachment.test.ts`, `src/index.test.ts` |
| M2.4-F04 | Permission resolution or exact-session preset mutation throws | Keep the last readable effective preset, expose a bounded error, and permit an explicit retry without retargeting another session. | `src/model/permission-controller.test.ts`, `src/index.test.ts` |
| M2.4-F05 | Durability barrier, raw-artifact read, export publication, or cancellation fails | Keep the live session attached, expose the exact bounded failure, leave an existing destination untouched, clean temporary files, and permit retry. | `src/model/recovery-controller.test.ts`, `src/runtime/session-export.test.ts` |
| M2.4-F06 | React/Ink rendering rejects after terminal acquisition | Stop accepting input, unmount first, dispose runtime ownership, restore raw/alternate-screen state, and exit non-zero while preserving the render failure. | `src/index.test.ts`, `src/cli.pty.test.ts` |
| M2.4-F07 | Terminal stdout emits `error` or closes unexpectedly | Convert the stream event into the renderer's primary exit failure, prevent an unhandled EventEmitter error, drain ownership, and request non-zero exit. Bytes cannot be restored after the transport itself is gone. | `src/ui/ink-lifecycle.test.ts`, `src/index.test.ts`, `src/cli.pty.test.ts` |
| M2.4-F08 | One or more disposers throw while another primary failure exists | Continue reverse-order teardown, retain labelled cleanup causes in an `AggregateError`, and keep the primary failure as the first outer cause. | `src/runtime/resource-owner.test.ts`, `src/index.test.ts`, `src/runtime/agent-attachment.test.ts` |

## Ownership decision

Failures are classified at their owner, not inferred by the renderer:

- controllers contain retryable, operation-local errors;
- the session attachment coordinator alone decides whether the parent can be
  restored without live-handle overlap;
- the session event pump converts a projection failure into one fatal runtime
  notification and silences later callbacks;
- the Ink lifecycle adapter converts output `error`/`close` events into its
  existing `exited` failure channel;
- the root resource owner unmounts the terminal before disposing session work,
  continues after cleanup errors, and aggregates every labelled failure.

The `exited` promise is the single renderer/output failure channel. Renderer
disposal awaits quiescence but does not repeat the same exit failure as a
second cleanup error. Independent cleanup failures are still aggregated.

## Verification layers

Controller and runtime tests deterministically inject every row. Fixed-size
snapshots cover visible failed session transitions. PTY tests prove alternate
screen and raw-mode restoration after normal, signal, and post-render failure.
The clean-package test exercises the packed bundle and exact Harness ownership
path. Cross-platform CI repeats the blocking suite on Linux, macOS, and
Windows; POSIX-only signal assertions remain gated by platform.
