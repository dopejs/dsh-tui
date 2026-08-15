# ADR-0004: Select Ink for terminal rendering

- Status: Accepted
- Date: 2026-08-15
- Supersedes: [ADR-0003](0003-defer-terminal-framework-selection.md)

## Context

ADR-0003 deferred the terminal framework until a project-specific spike could
measure bounded transcript rendering, assistant chunk updates, Unicode layout,
deterministic output, interaction ownership, and terminal restoration.

The viable Node 22 candidates were Ink 7.1.1 and Terminal Kit 3.1.4. OpenTUI was
excluded before implementation because its Node renderer currently requires
Node 26.4 with experimental FFI, above the Harness baseline.

The spike uses a 100-by-40 terminal and a 10,000-row mixed-width transcript. The
framework receives only the bounded visible window, including a modal with
explicit agent identity. It measures a static frame and a burst of twenty
assistant-chunk frames. PTY tests exercise normal quit, Ctrl-C input, SIGINT,
SIGTERM, and failure after terminal acquisition. On macOS, the tests also
compare `stty -g` before and after the child process.

Representative local results on arm64 macOS 26.6 and Node 22.22.0 were:

| Scenario | Ink 7.1.1 | Terminal Kit 3.1.4 |
| --- | ---: | ---: |
| Static bounded frame | 3.1–4.7 ms mean | 0.28–0.35 ms mean |
| Twenty-frame chunk burst | 55–75 ms mean | 5.7–5.9 ms mean |
| Normal/signal/failure PTY restoration | Pass | Pass |
| Deterministic mixed-width snapshot | Pass | Pass, with cell-dump padding artifacts |

The benchmark is reproducible with `pnpm bench`. The numeric results are local
evidence, not a portable CI performance budget; Milestone 2 will define those
budgets on representative CI hardware.

## Decision

Use Ink 7.1.1 with React 19.2.8 for the initial terminal renderer.

- All Ink and React types remain below `src/ui/`.
- Runtime ownership, reducers, controllers, and view models remain
  framework-neutral.
- The live renderer uses the alternate screen, incremental rendering, and a
  20 FPS cap after explicitly verifying interactive TTY input and output.
- The view model, not Ink, enforces transcript and tool-output bounds.
- Keep the Terminal Kit spike as a development-only benchmark until Milestone 2
  fixes performance budgets.

Ink is slower in the synthetic full-frame benchmark, but its measured time is
well within the required 20 Hz update interval even though `renderToString()`
rebuilds the frame from scratch. Ink provides stronger component composition,
fixed-width string rendering, input activation controls, resize handling, and
an explicit renderer instance with awaited unmount behavior. Those properties
rank ahead of raw throughput under the ADR-0003 selection criteria.

## Consequences

### Positive

- Fixed-size snapshots and component tests use the same layout engine as the
  live renderer.
- Yoga layout handles wrapping and mixed-width terminal composition without a
  local layout engine.
- Renderer ownership has explicit `unmount()` and `waitUntilExit()` seams.
- The selected version supports the repository's minimum Node 22 baseline.

### Negative

- React reconciliation and Yoga layout cost roughly one order of magnitude more
  than direct ScreenBuffer writes in the spike.
- React becomes a runtime dependency even though domain code remains
  framework-neutral.
- Performance depends on preserving the bounded-window and repaint-coalescing
  invariants; rendering the complete durable transcript would be unacceptable.

## Revisit triggers

Reconsider the renderer if Milestone 2 cannot meet its replay, resize, memory,
or input-latency budgets with a bounded view model and incremental rendering.
Terminal Kit is the measured low-level fallback. A native renderer requires a
separate decision covering Node ABI, binary distribution, and Windows support.

## Alternatives rejected

### Terminal Kit 3.1.4

Terminal Kit is viable and materially faster. It was not selected because its
imperative global terminal surface, manual layout, CommonJS boundary, and
lower-level focus composition increase lifecycle and UI-state complexity. It
remains the fallback if measured Ink performance becomes insufficient.

### OpenTUI

OpenTUI's native renderer is promising, but its current Node path does not run
on the pinned Node 22 baseline. Raising the entire Harness runtime baseline for
the TUI framework is not acceptable.

### Custom ANSI renderer

A custom renderer could minimize overhead but would make this project own
Unicode width, wrapping, diffing, focus, resize, and terminal capability logic
before an existing framework has failed a measured requirement.
