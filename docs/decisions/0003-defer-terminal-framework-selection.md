# ADR-0003: Defer terminal-framework selection

- Status: Accepted
- Date: 2026-08-15

## Context

The terminal framework is a consequential dependency: it controls input,
Unicode layout, raw mode, alternate-screen behavior, rendering performance,
testability, Windows support, and shutdown semantics. Choosing from popularity
alone would hard-code assumptions before the lifecycle and transcript workloads
are measured.

The core architecture does not require a particular component model. A renderer
can consume a framework-neutral view model.

## Decision

Do not select a terminal framework in the design scaffold. Milestone 1 will run
a bounded spike with at least two viable candidates and update this ADR (or
supersede it) with evidence.

The spike must implement the same scenarios:

- 10,000 transcript rows with a bounded visible window;
- 20 Hz assistant chunk updates without input starvation;
- Unicode, wide characters, combining marks, wrapping, and resize;
- approval modal plus multiline composer focus arbitration;
- deterministic fixed-size snapshot output;
- PTY exit after normal quit, exception, SIGINT, and SIGTERM;
- macOS, Linux, and credible Windows support;
- ESM and supported Harness Node versions.

Selection criteria, in priority order:

1. correct resource ownership and terminal restoration;
2. deterministic testability;
3. layout and Unicode correctness;
4. bounded rendering performance;
5. maintenance health and dependency footprint;
6. developer ergonomics.

Framework objects must remain under `src/ui/`; reducers and runtime ownership
must not depend on them.

## Consequences

### Positive

- The dependency is chosen using project-specific evidence.
- Architecture and documents can progress without creating throwaway UI code.
- A future renderer replacement has a defined boundary.

### Negative

- No runnable screen exists in Milestone 0.
- The framework spike adds a short deliberate step before feature work.

## Revisit trigger

Supersede this ADR when the spike records candidate versions, benchmark results,
platform findings, the selected framework, and known limitations.
