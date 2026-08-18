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

## M6.3 Streaming and Markdown (+5) — complete

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

## M6.4 References and attachments in the composer (+4) — complete

Two items in the original plan were already true and were verified rather than
rebuilt: `@` completion already matches anywhere in a message (it scans back
from the cursor to the token start), and the completion provider already
refuses absolute paths and anything resolving outside the workspace.

What was missing was resolution: `@path` only completed text, so the file never
went with the message.

- ~~accept `@path` anywhere in the message, not only at the start~~ (already true);
- resolve a referenced text file into the message as content, and a
  PNG/JPEG/WebP/GIF into a durable image block through `ctx.attachments`;
- show each resolved reference as a chip in the composer, removable before
  send;
- refuse a reference that leaves the workspace, and say so.

Verified: reference at start/middle/end and adjacent to punctuation; an
e-mail address that is not a reference; a path escaping the workspace; an
unreadable file; a binary file; an image with and without an attachment store;
a truncated oversized file; and that a refused reference reaches the user
rather than being dropped.

The composer chip UI is deferred: the submit-time report names every refused
reference, which is the property that matters — a silent drop is the one
outcome a user cannot detect.

## M6.5 Session workflow (+4) — complete, after one wrong turn

The slice began by re-implementing something that already existed.

Harness already registers the session commands its own services own, `/compact`
among them, and the palette has always merged them. Registering a second
`/compact` threw `command "compact" is already registered` — and because that
happened during binding creation, the whole interactive TUI failed to render.
`pnpm check` passed throughout; only launching the installed package caught it,
which is the third time that gate has caught something nothing else could.

The lesson is recorded and enforced: every TUI command now registers through a
guard that skips a name the composition already provides, so a future collision
degrades to a logged skip instead of a dead interface.

`/new` and `/model` were then added on that footing. Both were previously
deferred as risky; they are not. The session coordinator already exposes
`createSession`, which fork and resume use, so the no-overlap ownership
invariant holds for these without a second mechanism. `/model` parses the exact
`provider/model` selector the startup flag validates and applies it to the newly
created agent.

`/rename` is **not implemented and will not be** on this baseline.
`SessionPersistence` publishes `create`, `append`, `load`, `inspect`, `list`,
and `readFrom` — nothing that writes session metadata. Renaming would mean
rewriting a persisted header, which the delivery invariants forbid.

Deferred, with the reason:

- `/new` and `/model` mid-session both mean creating an agent and transferring
  the attachment. The session coordinator already does this for fork and
  resume, and reusing it correctly is a larger change than a command
  registration; doing it badly would risk the no-overlap invariant that M1.4
  and M2.3 established.
- double-`Esc` rewind depends on that same transition.

## M6.6 Working status (+3) — complete

A live row appears only while a turn is in flight: elapsed time, tokens per
second when a meaningful window has passed, reasoning effort when reported, and
the cancel key. An idle agent renders no row at all rather than a row of
blanks.

Two honesty rules are pinned by tests. A rate over a sub-second window is
noise, and a rate with no tokens is a throughput claim nothing has observed, so
both are withheld rather than shown as zero. And the impossible-duration guard
formats through the same path as a real one, so it cannot emit a shape the
normal path never produces.

The clock is state rather than a tick counter, so the elapsed value is genuinely
read where it is rendered. It starts on the idle→running edge and clears on the
way back, so a second turn never inherits the first one's start time, and the
interval exists only while work is in flight — an idle session holds no timer,
and reduced motion opts out of ticking entirely.

Git branch and dirty state are **not** included: reading them means running git
per turn boundary, and this milestone has no seam that reports them.

## M6.7 Reasoning policy (+2) — complete

The transcript rendered reasoning inline while `--print` excluded it. The cause
was structural: the reducer concatenated `Reasoning: …` into the row's content,
so no surface downstream could tell the two apart.

Reasoning now travels as its own field beside the answer. One policy applies
across all three surfaces, and a test asserts they agree rather than trusting
each in isolation:

- the transcript folds it behind `^E`, because a human may want the scratch
  work but must not mistake it for the conclusion;
- the clipboard omits it — pasting a model's deliberation into an issue as if
  it were the answer is the failure this prevents;
- `--print` omits it, because a pipeline consumer must never act on it.

## M6.8 Render modes and platform (+3) — complete except Windows

Render mode is a preference: `alternate` keeps the shell clean, `inline` leaves
the session in the terminal's own scrollback. Neither is universally right, so
it is chosen rather than assumed. It is read once at mount — switching buffers
under a live render would strand whatever was already drawn in the buffer being
left behind.

**Windows launcher support is not done, and not for want of trying.** Node
cannot execute a `.cmd` without a shell, and a shell would interpret the
arguments this launcher passes through from the user. Every workaround
available here — locating the shim's target JS by parsing it, or resolving the
CLI through a package path it is not a dependency of — is fragile in a way that
fails at the user's machine rather than in CI. Shipping `shell: true` to close
the gap would trade a missing feature for a command-injection surface, so the
launcher continues to decline and name the direct command. This needs an
upstream seam or a documented shim contract, not a local guess.

`/lang` is done. One table, one lookup, no formatting library, and a test that
requires every key to exist and be non-empty in every language — a
half-translated interface is worse than an untranslated one, because the
missing half is the half the user was relying on.

An unset preference follows the host locale rather than defaulting to English:
a user whose terminal is already Chinese did not choose English, they simply
never chose. `DSH_TUI_LANG` overrides the locale, and an explicit preference
overrides both. The table is resolved per render, so `/lang` takes effect
without a restart.

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

## Status

M6.0 through M6.8 are complete, with two exclusions recorded above rather than
left implicit: `/rename`, which no public seam supports, and the Windows
launcher, which has no execution path that avoids passing user arguments
through a shell.

The suite is 67 files and 616 tests; every source module is reachable. Three
gates run in CI — `pnpm check`, the module-reachability guard, and the
clean-profile install-and-launch — and the third caught two defects in this
milestone that nothing else could see: a duplicate command registration that
left the interface dead, and, earlier, one-shot runs that never exited.

## What M6 changed about how this repo works

Every defect that escaped in M5 and M6 shared a shape: the local gate was
satisfied by code that had never been run the way a user runs it. The
clean-profile launch gate now closes that, and three habits came out of it —
verify a claim before building on it (two M6.4 items already existed), check
whether the composition already provides a thing before adding it, and prefer a
reported limitation to a plausible-looking guess.
