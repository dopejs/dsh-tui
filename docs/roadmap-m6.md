# M6 — Claude-Code-class interface

## Why this milestone exists

M1–M5 targeted *capability*, on the explicit premise in
[Product design](product-design.md) that the goal is "product capability, not
visual imitation". That premise was wrong about the actual goal: the interface
is the product for a terminal tool, and a user comparing us to Claude Code and
to `@deepseek-harness-tui/dsh-tui` judged ours harder to use before judging
anything else.

M6 closes the interface gap. It does not discard M1–M5: the permission
fail-closed path, the reported capability boundaries, and the verification
discipline stay exactly as they are. What changes is the surface.

## Delivery invariants

The M1–M5 invariants continue to apply. Two more govern this milestone:

- Presentation state never enters the durable log. Folding, expansion, render
  mode, and theme are local; the transcript remains derived from
  `session/event`.
- A visual affordance names the key that operates it. A fold, a mode, or a
  panel the user cannot discover how to reach is not a feature.

## Completed

- **M6.0 Launcher** — `dtui` resolves the CLI, bootstraps the profile pinned to
  its own version, handles version skew by direction, and passes arguments
  through. Declines on Windows rather than spawn `dsh.cmd` through a shell that
  would interpret user-supplied arguments.
- **M6.1 First screen and status** — welcome panel; context gauge drawn only
  when usage is actually reported; loaded-source summary that omits zeroes.
- **M6.2 Transcript legibility** — injected context folds to one line with a
  discoverable expand key; role markers verified one cell wide and mutually
  distinct; framed composer with an empty-draft hint.

## M6.3 Streaming and Markdown (+5)

The single largest remaining difference in how a session *feels*. The reducer
already folds `assistant/chunk`, so the work is presentation.

- render assistant text as Markdown: headings, fenced code with language,
  lists, inline code, block quotes, links as text plus a safe OSC 8 target;
- stream tokens into the live row instead of appearing per message, with a
  working indicator that shows elapsed time and cancels with `^C`;
- keep the plain-text projection for OSC 52 copy free of markup and escapes.

Verification: fixed-width snapshots per element at 40/80/120; a fuzz case for
unterminated fences and nested lists; the copy projection asserted to contain
no ANSI; a streaming test that asserts rows coalesce rather than duplicate.

## M6.4 References and attachments in the composer (+4)

`@` completion exists for paths but only as a leading token, and attachments
live in a separate panel.

- accept `@path` anywhere in the message, not only at the start;
- resolve a referenced text file into the message as content, and a
  PNG/JPEG/WebP/GIF into a durable image block through `ctx.attachments`;
- show each resolved reference as a chip in the composer, removable before
  send;
- refuse a reference that leaves the workspace, and say so.

Verification: reference at start/middle/end and adjacent to punctuation; a
binary file that is not a supported image; a path escaping the workspace; a
file exceeding `imageLimits`; replay showing the attachment reference survives.

## M6.5 Session workflow (+4)

Everyday operations currently require leaving the TUI or the recovery panel.

- `/new`, `/compact`, `/export`, `/rename` registered as TUI commands so they
  appear in the palette beside Harness's own;
- `/model` switching mid-session through the public model registry, applied to
  a newly created agent with the existing no-overlap transition;
- double-`Esc` opens the rewind/fork chooser over the retained transcript,
  reusing the M2.3 fork path rather than a second mechanism.

Verification: each command against a missing service; `/compact` asserted to
leave the durable log intact; a rewind that is cancelled leaves the attachment
usable; model switch applies to the exact new agent.

## M6.6 Working status (+3)

- a live status row: current activity, elapsed time, tokens per second;
- reasoning effort, cache hit rate, and input/output split when the projection
  reports them — omitted, not zeroed, when it does not;
- Git branch and dirty state, read once per turn boundary rather than polled.

Verification: every field absent yields no row rather than a row of blanks;
width degradation at 40/80/120; no polling timer survives disposal.

## M6.7 Reasoning policy (+2)

Reasoning is currently rendered inline in the transcript while `--print`
deliberately excludes it. That inconsistency is unresolved, not intentional.

- decide one policy: folded-by-default in the interactive transcript, still
  excluded from `--print`, on the grounds that a human may want the scratch
  work but a pipeline consumer must not act on it;
- make it a preference, defaulting to folded.

## M6.8 Render modes and platform (+3)

- inline versus alternate-screen rendering, chosen by preference and by whether
  the terminal supports it;
- Windows launcher support, which needs an execution path that does not pass
  user arguments through a shell;
- `/lang` interface language, which requires extracting the currently inlined
  English strings into one table.

## Sequencing

M6.3 first: it changes every session, and the plain-text and copy paths it
touches are load-bearing for later work. M6.4 next, being the highest-frequency
composer interaction. M6.5 and M6.6 are independent and can follow in either
order. M6.7 is small and unblocks nothing, but it removes a live inconsistency.
M6.8 is last: the largest surface, the least daily impact.

## What this milestone will not do

- Copy the reference implementations' code. Both are MIT, and their patterns
  are worth following — the launcher's skew handling already is — but the
  implementations here stay ours, with attribution where a pattern is borrowed.
- Regress the reported capability boundaries. Where this baseline publishes no
  seam, the panel keeps saying so rather than growing a plausible fiction.
