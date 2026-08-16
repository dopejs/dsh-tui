# Architecture decision records

Accepted decisions are immutable history. A later decision may supersede one,
but should not silently rewrite its context or consequences.

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](0001-use-an-in-process-harness-bundle.md) | Accepted | Ship as an in-process, out-of-tree Harness bundle. |
| [0002](0002-render-the-durable-session-log.md) | Accepted | Derive the human transcript from durable session events. |
| [0003](0003-defer-terminal-framework-selection.md) | Superseded by 0004 | Select the terminal framework through a bounded implementation spike. |
| [0004](0004-select-ink-for-terminal-rendering.md) | Accepted | Use Ink behind the terminal rendering adapter. |
| [0005](0005-separate-conversation-recovery-from-file-rewind.md) | Accepted | Separate durable conversation recovery from capability-gated file rewind. |
| [0006](0006-observe-background-jobs-without-consuming-them.md) | Accepted | Observe background jobs through non-consuming registry seams only. |
