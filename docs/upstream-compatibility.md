# Upstream compatibility

## Baseline

The initial design was inspected against DeepSeek Harness:

| Field | Value |
| --- | --- |
| Repository | `deepseek-ai/deepseek-harness` |
| Commit | `47f943859bef60e4160492346772ded9b24f765a` |
| Source manifest version | `0.1.0-rc.5` |
| Published package baseline | `0.1.0-rc.7` |
| Source inspection date | 2026-08-14 |
| Artifact verification date | 2026-08-15 |
| Node engine | `^22.19.0 || >=24.0.0` |
| Package manager | `pnpm@11.7.0` |
| Cordis | `4.0.1` |
| Cordis loader | `1.0.2` |

The fixed source commit carries `rc.5` package manifests, but npm does not
publish that version; the installable artifacts are `rc.6`. The relevant Agent,
Session, default-model, and Cordis declarations were checked from the installed
artifacts and exercised through their public entry points. Harness is a
developer preview, so the runtime package pins exact tested peers and does not
assume compatibility across release candidates.

On Linux, Harness `0.1.0-rc.7` loads `node-pty@1.1.0`, whose npm artifact must
compile its native addon during installation. pnpm 11 `dlx` invocations must
therefore pass `--allow-build=node-pty`; no broader dependency-script allowance
is required by this bundle.

## Public contracts the TUI expects

- Profile bundles declared through `dsh.bundle.patch` and layered over
  `@deepseek-ai/dsh-base`.
- Application arguments exposed through `ctx.cmdlineArgs`.
- `ctx.agents.create()` / `resume()` returning an owned `AgentHandle`.
- `Agent.followup()`, `steer()`, `cancel()`, status, inbox, and agent-scoped
  context.
- Durable `Session.events` and `session/event`, including event sequence.
- `ctx.tools.get()` and provider-neutral `presentCall` / `presentResult` intents.
- `ctx.commands.list()` / `execute()`.
- `ctx.llm.resolveModelInfo()` and `ctx.agentDefaultModel.currentSelection()`
  for pre-creation model selection and fallback.
- `ctx.permissionPresets` for preset discovery, consequence preview, effective
  state, and exact-session writes.
- `approval/request` answerer waterfall.
- `ctx.userQuestions.registerProvider()`.
- `ctx.sessionPersistence.list()` / `inspect()` where session browsing needs
  them; resume itself remains owned by `ctx.agents.resume()`.
- `ctx.sessionProjections.snapshot()` / `onChanged()` for optional domain views.
- `ctx.jobs.list()` / `get()` / `kill()` / `onJobsChanged()` / `onJobDone()` for
  background-job observation and owned cancellation; the consuming `read()` and
  the admitting `attachController()` are deliberately not consumed.
- `ctx.appExit` is honoured only after the launcher installs its shutdown
  controller, which is later than the runtime plugin's `start`; a one-shot run
  must keep requesting until it is acted on. `loader.await()` is not a
  readiness signal — it does not settle while the runtime is live.
- `ctx.attachments.imageLimits` / `validateImage()` / `saveImage()` for image
  inputs; admission and every size bound stay the store's decision.
- `ctx.tools.schemas()` plus the `tools/change` event for the MCP inventory;
  server grouping uses only the documented `mcp__<server>__<raw>` name grammar.
- `ctx.skills.snapshot()` / `get()` for abortable, completeness-aware skill
  discovery and body reads.
- `ctx.settings.register()` plus the returned scope's `get()` / `watch()` /
  `update()` for the `dsh-tui` preference namespace; `SettingsProvider.writable`
  gates whether persistence is promised at all.
- `ctx.subagents.listDescendants()` / `followup()` / `interrupt()` for the
  subagent tree and its controls; child attachment stays owned by the session
  attachment coordinator.

## Production-roadmap capability map

The M1–M5 design was audited against the same pinned source and published
baseline. The TUI may add the service-definition packages as exact peers when a
slice begins consuming them, but it must continue using only their root package
exports.

| Product capability | Public Harness owner on the baseline | Baseline state |
| --- | --- | --- |
| Session list and inspection | `@deepseek-ai/dsh-session-persistence` / `ctx.sessionPersistence` | Available in `dsh-base` |
| Exact-session durability barrier | `@deepseek-ai/dsh-session` / `ctx.sessions.flush()` | Available; zero listeners is reported as failure |
| Raw session export | `ctx.sessionPersistence.supportsRawArtifacts` / `readRaw()` | Backend-gated; unavailable without a verbatim artifact |
| Conversation fork with live agent | `ctx.agents.create()` seed plus `parentSession` lineage | Available at the current idle balanced boundary |
| Session metadata search | `@deepseek-ai/dsh-session-query` | Query mounted in `dsh-base`; full-text search disabled by default |
| Model catalog and default selection | `ctx.llm`, `@deepseek-ai/dsh-agent-default-model` | Available in `dsh-base` |
| Permission modes | `@deepseek-ai/dsh-permission-presets` / `ctx.permissionPresets` | Available in `dsh-base` |
| Sandbox enforcement | `@deepseek-ai/dsh-sandbox-policy` and selected sandbox provider | Available in `dsh-base`; enforcement stays upstream-owned |
| Todo/goal/plan/usage/subagent read models | `@deepseek-ai/dsh-session-projection` / `ctx.sessionProjections` and registered projection units | Registry available; individual views are capability-gated |
| Background jobs | `@deepseek-ai/dsh-jobs` / `ctx.jobs` | Local provider available in `dsh-base`; `read()` and `attachController()` are consuming/admitting and stay unused (ADR-0006) |
| Subagents | `@deepseek-ai/dsh-subagent` plus registered providers and projections | Available in `dsh-base`; `followup()` requires the exact live direct parent, so the TUI addresses only its own direct children |
| Settings | `@deepseek-ai/dsh-settings` / `ctx.settings` | File-backed provider available in `dsh-base` |
| Skills | `@deepseek-ai/dsh-skill` / `ctx.skills` | Filesystem provider available in `dsh-base` |
| Hooks | None | No public inventory service on the baseline; must fail closed |
| MCP tools | `@deepseek-ai/dsh-mcp-client` registrations in `ctx.tools` | Optional per user profile; no server-health registry on the baseline |
| Plugin state | `@deepseek-ai/dsh-host-plugin-inventory` / loader projection | Public package exists but is not mounted by `dsh-base`, and exposes the projection only as a Typert *remote* gateway with no Cordis context service; unreachable in-process |
| Attachments | `@deepseek-ai/dsh-attachment` / `ctx.attachments` | Local provider available in `dsh-base` |
| Durable session checkpoint policy | `@deepseek-ai/dsh-session-checkpoint-policy` | Persistence durability only; not file rewind |
| File checkpoint/rewind | None | Unavailable; must fail closed |
| Worktree enumeration | None | No service; workspaces are derived from durable session `cwd` alone |
| Remote TUI attachment | SDK/API packages exist for other products | Out of scope until a second concrete transport exists (ADR-0007) |

“Available” means a public service contract exists, not that the TUI may assume
every deployment mounts it. Optional integrations still require an explicit
unavailable state, injected fixture, cancellation, and disposal test.

## Compatibility rules

1. Import only package exports documented by the owning upstream package.
2. Never import an upstream `src/*` path even if an installed package happens to
   expose source files.
3. Preserve unknown merge-extensible event types and render safe fallbacks when
   possible; fail loudly when a required event format is unsupported.
4. Keep any compatibility adapter at one named boundary with tests for every
   supported upstream version.
5. Do not rewrite persisted sessions to accommodate a TUI release.
6. Record each tested upstream version and CI result in the matrix below.

## Tested version matrix

| dsh-tui | Harness | Status | Notes |
| --- | --- | --- | --- |
| `0.1.0` | `47f9438` / npm `0.1.0-rc.6` | Release-candidate verification | Exact peers; public exports only; create/resume, transcript, tools, commands, approval/questions, clean tarball install, and PTY teardown covered. |
| `0.1.0` | `47f9438` / npm `0.1.0-rc.6` | M1–M5 complete | Adds jobs, subagents, projections, skills, settings, attachments, and the MCP/plugin inventories. CI run `31994925629` green on ubuntu (Node 22.19.0, 24.x), macOS, and Windows; `--doctor` and `--print` verified against a clean installed profile. |

### 0.2.0

Adds the M6 interface work — `dtui` launcher, Markdown rendering, `@`
references, working status, `/lang`, render modes — against the same exact
`0.1.0-rc.6` peers. No Harness contract changed; the compatibility claim is
unchanged from 0.1.0.

## Upgrade procedure

For each Harness upgrade:

1. Read upstream architecture, package READMEs, release notes, and relevant
   event/type diffs.
2. Diff the public contracts listed above.
3. Run compile, reducer fixtures, integration, snapshots, PTY, and clean-profile
   install tests against the candidate.
4. Add or adjust a compatibility adapter only when the old and new behaviors can
   both be represented correctly.
5. Update this matrix and the package peer range in the same change.
6. If correct compatibility requires private imports or guessing at semantics,
   stop and propose an upstream public seam instead.

## Upstream contribution policy

A DeepSeek Harness change is justified only when a concrete TUI scenario cannot
be implemented correctly through existing public services. An upstream proposal
must identify:

- the missing capability and current failure mode;
- why existing events/services cannot express it;
- the smallest provider-neutral contract;
- at least one provider and consumer;
- lifecycle, cancellation, replay, and compatibility behavior;
- tests in both Harness and `dsh-tui`.

UI convenience alone is not a reason to add behavior to the agent loop.

### 0.2.1

Upstream published `0.1.0-rc.7`. `0.2.0` pinned its Harness peers to exactly
`0.1.0-rc.6`, so the moment the host's `latest` moved, the documented install
became an `ERESOLVE` for every new user — the package was green in CI and
uninstallable in practice. `0.2.1` widens every Harness peer to `^0.1.0-rc.6`
and verifies the whole suite against `0.1.0-rc.7`.

Neither gate could have caught this: `pnpm check` resolves the pinned tree in
this repository, and the clean-profile smoke pinned the host version too. The
new `pnpm check:peers` gate installs the real tarball beside
`@deepseek-ai/dsh@latest` under npm's strict peer resolution, which is what a
new user actually runs. It was mutation-verified: reinstating the exact pins
turns it red with `ERESOLVE`.

| Version | Verified against | Scope | Notes |
| --- | --- | --- | --- |
| `0.2.1` | npm `0.1.0-rc.7` | Peer-range widening | No behaviour change; 617 tests, clean-profile launch, and registry peer resolution all green. |

### 0.2.2

`npm install -g @deepseek-ai/dsh @dopejs/dsh-tui` — the command this README has
documented since `0.1.0` — had never once succeeded. Under `0.1.0` and `0.2.0`
it failed with `ERESOLVE`; once `0.2.1` widened the ranges it failed with an npm
internal crash, `Cannot read properties of null (reading 'children')`, thrown
from arborist's `PlaceDep`.

The cause is that the twenty Harness `peerDependencies` were never satisfiable
by any installer. A `tui` profile installs four small packages
(`cosmokit`, `dsh-cmdline`, `dsh-code-runtime-worker-thread`, `schemastery`);
the Harness runtime comes from the `dsh` CLI's own dependency tree at load time.
The peer ranges are a compatibility declaration, not an install instruction — so
they are now `peerDependenciesMeta: { optional: true }` and npm stops trying to
place them at the global root.

Tradeoff: npm no longer refuses an install on a peer-range mismatch. That signal
was never real (nothing installed the peers, so nothing checked them at install
time); what does check is `--doctor`, which resolves every required service
against the running host and reports what is missing. Compatibility remains
tracked in this document rather than enforced by the resolver.

`pnpm check:peers` now installs the tarball **globally** beside
`@deepseek-ai/dsh@latest` and asserts `dtui` lands on PATH. Mutation-verified:
removing `peerDependenciesMeta` reproduces the arborist crash exactly.

| Version | Verified against | Scope | Notes |
| --- | --- | --- | --- |
| `0.2.2` | npm `0.1.0-rc.7` | Global install path | `npm i -g` succeeds; `dtui --doctor` bootstraps the profile and reports all 8 required services resolved. No behaviour change. |

### 0.2.3

`0.2.2` fixed the install and left the *upgrade* broken. `npm i -g` moves the
launcher and moves nothing else, so the first `dtui` after any upgrade found an
older package in the profile and refused, printing a command for the user to
retype:

    [tui] Profile has @dopejs/dsh-tui@0.1.0, launcher is 0.2.2. Starting would
    apply this launcher's bundle patch to the older package and fail on module
    resolution. Align them with:
      dsh plugin --profile tui add @dopejs/dsh-tui@0.2.2

Refusing to *start* is still right — the bundle patch really would break module
resolution — but realigning is one unambiguous action the launcher already knows
how to take, and it now takes it. Only a profile that is *ahead* is left alone;
downgrading it would overrule a deliberate install.

The decision moved into `bin/version-skew.js` so it can be tested without a
network or a global install, and the existing process-level test now asserts the
launcher actually invokes `dsh plugin add` rather than merely saying so. Both
were mutation-verified.

| Version | Verified against | Scope | Notes |
| --- | --- | --- | --- |
| `0.2.3` | npm `0.1.0-rc.7` | Upgrade path | `dtui` realigns a stale profile and starts. 624 tests, clean-profile launch, global and local install resolution all green. |

### 0.2.4

Three interface defects, all found by running a real session rather than by any
gate.

The reply was invisible. The durable log was correct — a `reasoning` block at
index 0, a `text` block at index 1 carrying the answer — but the row rebuilt on
`assistant/message` ran the blocks through a projection that prefixed reasoning
with `Reasoning: ` and joined it to the answer. The streaming path split them
correctly and the finished-message path glued them back together, so every
reasoning guarantee held until the turn ended and then silently stopped: the
fold key went inert, the clipboard carried deliberation, and the answer read as
a continuation of the model's scratch work.

Worse, a test asserted the broken output as expected (`'Reasoning: think\nhello!'`)
while `reasoning-policy.test.ts` asserted the opposite policy. Two suites
contradicted each other and the runtime followed the wrong one. The policy suite
now covers the finished-message path, where it actually broke, and was
mutation-verified.

The composer drew its placeholder without the `› ` prefix, so the cursor cell
read as an indent rather than a caret and the line jumped sideways on the first
keystroke. The hint now uses the same row layout as real text.

The status chrome sat above the transcript, pushing the conversation down behind
five lines of session metadata. It now renders below the composer, which is
where Claude Code puts it and where the cursor already is.

| Version | Verified against | Scope | Notes |
| --- | --- | --- | --- |
| `0.2.4` | npm `0.1.0-rc.7` | Interface defects | 625 tests, clean-profile launch, global and local install resolution all green. |

### 0.2.5

The caret was invisible while typing. The end-of-line cursor token carried a
full block glyph *and* was rendered inverted, so inversion painted the block in
the background colour — an invisible cursor on a dark theme. The placeholder
path had always used an inverted space, which is why the caret was visible
before the first keystroke and gone after it. Both tests asserted the glyph
`█` rather than that anything was visible, so they stayed green through it.
The cursor now carries a cell for inversion to show, and the tests assert that
invariant instead. Mutation-verified.

The working line lived in the status area below the composer. A model thinking
is part of the exchange being read, and reporting it three lines below the
composer makes the user look away from where the reply is about to appear. It
now sits at the foot of the conversation. Nothing had asserted its position at
all — the move broke no test — so `layout.test.tsx` now pins ownership rather
than order, because the two regions are adjacent in a combined render and an
order assertion alone stayed green with the line back in the status area.

Each injected reminder spent two lines: one for the content, one for the fold
summary. A turn carrying three reminders spent six lines saying nothing the
user asked for. The summary now rides on the same line.

The status footer was five lines — the same clutter the header used to be, just
moved. It is two: identity and route, then consumption and position.

| Version | Verified against | Scope | Notes |
| --- | --- | --- | --- |
| `0.2.5` | npm `0.1.0-rc.7` | Interface layout | 631 tests, clean-profile launch, global and local install resolution all green. |

### 0.2.6

Every interface defect this project shipped survived the suite, because the
suite renders through `renderToString`. That helper produces text. A terminal is
a grid that escape sequences mutate: cells get overwritten, inversion is what
makes a caret visible, and the alternate screen is a separate buffer. Nothing
could see any of that.

`test-fixtures/screen-harness.ts` drives the real `InteractiveTui` under a PTY
and feeds the bytes through a headless terminal emulator, so a test can read the
screen as a user sees it — glyphs, cell attributes, cursor, buffer identity.
`src/ui/screen.pty.test.ts` asserts, on a real terminal, that the interface takes
the alternate screen, draws a visible caret while typing, shows the answer while
folding reasoning, folds an injected reminder onto one line, and never overwrites
one row with another.

Two things it caught immediately, both of which every prior gate had missed:

- `isInverse()` answers with a bit flag, not `1`. The harness's own first
  assertion compared it against `1` and reported every caret as missing.
- Inversion alone is not visibility. Restoring the shipped defect — a full block
  glyph under the caret — leaves the cell inverted, so an inversion-only
  assertion stays green. What made it invisible was the glyph: inverting a cell
  that is already full paints it in the background colour. The test now
  constrains the glyph, and reinstating the defect turns it red.

Fullscreen is still not delivered. Pinning the layout to the viewport height was
attempted and reverted: content exceeding a fixed height garbles cells, and
until this harness existed there was no way to tell a real defect from a
`renderToString` artefact. That work now has something to verify against.

| Version | Verified against | Scope | Notes |
| --- | --- | --- | --- |
| `0.2.6` | npm `0.1.0-rc.7` | Real-terminal test harness | 636 tests including five on a live PTY; clean-profile launch and install resolution green. No runtime behaviour change. |

### 0.3.0

Fullscreen, delivered. `alternateScreen: true` had been passed since `0.1.0`,
so the interface always took the alternate screen — and never filled it. The
root box had no height, so the conversation, composer and status floated
wherever the content happened to end and the bottom of the terminal was dead
space. Swapping the buffer was the whole of what "fullscreen" meant here; the
layout never noticed.

The layout is now pinned to the viewport on the alternate screen: the
conversation takes the slack, which puts the composer at the bottom edge with
the status beneath it. `inline` is unchanged and must stay unchanged — a fixed
height there would blank out the shell's own scrollback.

This was attempted once before and reverted, because `renderToString` produced
garbled output and there was no way to tell a real defect from an artefact of
that helper. With the PTY harness the answer is unambiguous: on a live terminal
the layout renders correctly, and the garbling was the helper, which does not
model a viewport — it does not clip, it overwrites. The unit snapshots therefore
render `inline`; they assert content, and screen geometry is asserted against a
real terminal.

Two things worth stating plainly:

- The overflow test passes with the clip removed. What keeps the conversation
  inside its space is the row budget, not `overflow: hidden`. The clip stays as
  a guard against that budget being wrong, but it is untested and is documented
  as such rather than trusted.
- Mouse support remains absent. Ink 7.1.1 exposes no mouse API at all, so it
  requires enabling SGR mouse mode, parsing the sequences off stdin, and hit
  testing against `useBoxMetrics`. It is not started.

| Version | Verified against | Scope | Notes |
| --- | --- | --- | --- |
| `0.3.0` | npm `0.1.0-rc.7` | Fullscreen layout | 638 tests including seven on a live PTY; clean-profile launch and install resolution green. |

### 0.3.1

The reasoning fold was drawn between the answer's first line and the rest of
it, cutting one reply in half around a note about scratch work:

    ⏺ Hi! I'm in the doper workspace — a Web canvas rendering engine…
      reasoning hidden · ^E show
      What would you like to work on?

Both halves are one answer. The fold now sits above the row, which is also the
order the durable log emits: a `reasoning` block at index 0, the `text` block
carrying the answer at index 1. Deliberation first, folded; then the answer,
whole and contiguous.

The reasoning-policy tests asserted that reasoning was folded and excluded from
the clipboard and `--print`, and every one of them passed while the fold split
the answer — they constrained what reasoning must not leak into, never where it
is drawn relative to the text. The screen test asserts the placement on a live
terminal and was mutation-verified.

| Version | Verified against | Scope | Notes |
| --- | --- | --- | --- |
| `0.3.1` | npm `0.1.0-rc.7` | Reasoning placement | 639 tests including eight on a live PTY; clean-profile launch and install resolution green. |

### 0.4.0

Injected context is withheld from the conversation by default, and a user turn
is drawn as a band across the terminal.

A session opened on the host's injections — `<system-reminder>`, runtime context
snapshots, instruction files — three of them ahead of the first answer. Folding
each to one line, in `0.2.5`, was not enough: the user is reading a
conversation, and none of that is conversation. Each injection is content the
model was given, not content anyone asked to read.

So they are withheld, never discarded. Injected content now has its own row
kind, `context`, separate from `system` — which stays visible, because a notice
like "Approval policy changed to never" is meant to be read. The status line
reports how much is being held back (`1 context hidden`), and the command
palette draws it inline again, still folded to one line per injection and still
expandable. The whole round trip is asserted on a live terminal: Ctrl-P, search,
Enter, and the reminder appears.

Every row also used to begin the same way, so finding where an exchange started
meant reading rather than looking. A user turn is now inverted across the full
terminal width — measured in cells, not code units, so a CJK turn does not run
the band past the right edge. The screen test counts the inverted cells on the
user's row against the terminal width, and asserts the reply carries none.

| Version | Verified against | Scope | Notes |
| --- | --- | --- | --- |
| `0.4.0` | npm `0.1.0-rc.7` | Transcript legibility | 641 tests including nine on a live PTY; clean-profile launch and install resolution green. |

### 0.4.1

Two things Claude Code has that this did not: how long the model thought, and
room to breathe between turns.

The thinking duration is measured from the durable event times — reasoning
`block-start` to `block-end` — not from a clock the renderer keeps, so a resumed
session reports what it reported live. It is carried explicitly across the
`assistant/message` rebuild, which is the same step that once dropped the
reasoning itself and would have dropped this by the same accident. The fold now
reads `thought for 4.2s · reasoning hidden · ^E show`.

Turns are separated by a blank line.

That blank line exposed a real defect. The window budgeted a transcript row as
its content alone, so with a separator per row it handed the renderer more rows
than the space could hold, and the excess was drawn straight through the
composer: a fused border and input line, and a status line written over its own
second half. The row height now counts the separator and the reasoning line.

The garbling assertion had missed it. It looked for a border glyph in a line's
interior, and in the real failure the closing glyph landed at the end of the
row, where it always belongs. It now asserts the composer's three rows hold what
they should and nothing else, and that the status lines are not fused.

Twice while chasing this the diagnostic ran with output sent to `/dev/null`, so
a failing fixture left a stale file that read as a successful run. The fixture
had been conflating `seq` with `time` — the reducer requires contiguous
sequence numbers, which makes a four-second thought unrepresentable if the two
are the same field.

| Version | Verified against | Scope | Notes |
| --- | --- | --- | --- |
| `0.4.1` | npm `0.1.0-rc.7` | Thinking duration, turn spacing | 643 tests including eleven on a live PTY; clean-profile launch and install resolution green. |

### 0.4.2

The user band inverted every cell in the row. Inversion is the loudest thing a
terminal can do, and spent on the most ordinary row on screen it reads as a bar
of glare rather than as a marker. The default theme now raises the background
instead — `blackBright`, present enough to find at a glance and quiet enough to
sit behind text. `high-contrast` keeps the inversion, which is the point of that
theme, and `no-color` draws no band at all: it promises no colour, and the role
marker already tells the rows apart. A row is padded to the terminal width only
when a band is actually drawn.

The screen test now asserts the band by background rather than by inversion, and
asserts the user row carries no inversion — otherwise swapping one for the other
would have left it green either way.

The harness had the same defect twice over: `isBgDefault()` answers with a
boolean while `isInverse()` answers with a bit flag, and comparing either
against a specific number reports the attribute as absent. The first version of
the band assertion compared against `0` and found nothing on a correctly banded
row.

| Version | Verified against | Scope | Notes |
| --- | --- | --- | --- |
| `0.4.2` | npm `0.1.0-rc.7` | Band contrast | 645 tests including eleven on a live PTY; clean-profile launch and install resolution green. |

### 0.5.0

The wheel scrolls the transcript. Ink 7.1.1 exposes no mouse API at all, so the
protocol is handled here: SGR reporting is asked for at mount, decoded, and
turned off on the way out.

SGR (`?1006`) rather than the original X10 encoding, which packs coordinates
into single bytes and silently stops above column 223 — a width a full-screen
terminal reaches — and which cannot distinguish a release.

Ink reads stdin itself, so a terminal asked to report sends Ink escape sequences
it can only read as typing: clicking would put `[<0;12;5M` in the composer.
Filtering after the fact is impossible, since Ink's listener sees the same bytes,
so Ink is handed a stream this owns, with the reports removed. The proxy
delegates raw mode, TTY identity and reference counting to the real descriptor,
because those belong to the real one; only the data is rewritten. A report split
across two reads is reassembled, and a fragment that never completes is released
rather than held forever.

Three things the real-terminal test caught that nothing else would have:

- The wheel direction was inverted. The offset counts rows back from the tail,
  so scrolling up is a positive step. Read the other way the wheel is inert at
  the tail, where a session spends most of its time, and the feature looks
  unimplemented. A unit test asserting `scrollLines` was called would have
  passed.
- The screen fixture mounted `InteractiveTui` directly, leaving the mouse wiring
  outside everything the screen tests exercise — removing the stdin filter kept
  them green. The fixture now mounts through `mountInkApplication`, the same
  entry point the plugin uses.
- Nothing asserted that reporting stops. A terminal left reporting prints escape
  sequences into the user's shell on every click afterwards; it looks like a
  corrupted terminal and outlives the process that caused it. That is now
  asserted after a real exit through the command palette, since no cell on
  screen can show it.

The first implementation attached a `data` listener to stdin. That assumes the
stream is flowing and that this process reaches it first, and neither is
guaranteed: under the real host the interface received no keystrokes at all and
could not even be exited. Piping instead lets Node handle flow control, which
was the part being assumed. Only `pnpm test:package` caught it — the unit tests
and the PTY screen tests both passed throughout, because in both the fixture
owns stdin outright.

Teardown order matters too: Ink reads the filtered stream, so ending it
underneath a live renderer also left the installed TUI unable to exit. The
renderer is disposed first, then reporting is turned off, then the filter is
released.

And flow control has to reach the real descriptor. The proxy forwarded TTY
identity and raw mode but not `pause`, so Ink pausing on unmount paused only the
filter while the real stdin kept flowing with its handle open. On Linux that
kept the process alive after the interface was gone; macOS exited regardless, so
only CI saw it — the first platform-specific defect this project has hit since
the OSC 8 assertion in `0.1.0`.

The exit assertion was flaky on Linux with Node 24, roughly one run in two,
while passing everywhere else. It pressed Enter as soon as the action appeared
in the palette, which is a different moment from the action being selected. It
now waits for the selection marker. A flaky red is worse than no gate: it
teaches you to re-run rather than to read.

Clicking is not implemented: only the wheel. Reports for presses and releases
are decoded and delivered, and nothing consumes them yet.

| Version | Verified against | Scope | Notes |
| --- | --- | --- | --- |
| `0.5.0` | npm `0.1.0-rc.7` | Wheel scrolling | 665 tests including thirteen on a live PTY; clean-profile launch and install resolution green. |

### 0.5.1

Half-typed pinyin appeared outside the composer, on whatever line happened to
be below it.

The caret drawn in the composer is an inverted cell — something a person can
see and an input method cannot. A composing character is drawn by the terminal
at the *hardware* cursor, which Ink parks wherever it last wrote. The terminal
cursor is now placed on the caret, measured in cells rather than code units so a
CJK character, which occupies two, does not drift it left by one cell per
character already committed.

Two things had to be got right, both found against a real terminal:

- Ink writes the cursor while flushing a render, and setting a position does not
  itself cause one, so the last move was never flushed and the cursor stayed
  where the previous keystroke left it. One extra frame is forced when the
  position actually changes; it settles immediately, because the next pass
  computes the same position and asks for nothing.
- Ink moves the cursor up from the last line of output rather than from the line
  after it, so a position lands one row high. Corrected by measurement, and the
  screen test holds it there: if a future Ink fixes the arithmetic, that test
  goes red rather than the cursor drifting quietly.

Shift-Enter is accepted as a newline where a terminal reports it distinctly.
Most do not — the same byte is sent for Enter and Shift-Enter — and the Kitty
keyboard protocol, which would distinguish them, is not enabled: asking for it
made the terminal's reply to the capability query arrive in the composer as
text, five invisible characters ahead of the caret. Ctrl-J and Alt-Enter remain
the newline that works everywhere.

| Version | Verified against | Scope | Notes |
| --- | --- | --- | --- |
| `0.5.1` | npm `0.1.0-rc.7` | IME cursor placement | 669 tests including fifteen on a live PTY; clean-profile launch green. |

### 0.5.2

Mouse reporting did nothing on Ghostty, and took text selection away
everywhere.

It was asked for before the renderer took the alternate screen. Terminals keep
private mode state per screen buffer, so a mode set on the primary screen is not
in effect once the alternate one is entered: the request was simply discarded.
The emulator the screen tests run against does not separate the buffers, kept
the mode, and stayed green through all of it — the first defect this harness has
missed, and a reminder that an emulator is a model of a terminal, not a
terminal. Reporting is now asked for after the screen is taken, and the test
asserts that order in the byte stream rather than the behaviour it produces.

The second half was not a bug but a cost nobody was told about: while a terminal
reports mouse events it stops making selections of its own, so dragging no
longer selects text. Most terminals let Shift bypass that; not all do, and
nobody should have to know. `Toggle mouse reporting` in the command palette
hands it back outright, at which point selection behaves exactly as it did
before any of this existed. The screen test drives the toggle through the
palette and asserts both that the terminal was told to stop and that the wheel
then does nothing.

Two flakes, handled differently. The exit assertion typed a phrase with a space
into the palette, giving per-keystroke filtering a chance to be mid-update when
Enter arrived; it now types a single word, and twelve consecutive runs are
green. The clean-profile smoke failed once at the session-centre step under load
and passed on re-run — observed, not diagnosed, and recorded here rather than
dismissed.

| Version | Verified against | Scope | Notes |
| --- | --- | --- | --- |
| `0.5.2` | npm `0.1.0-rc.7` | Mouse mode ordering | 671 tests including seventeen on a live PTY; clean-profile launch green on the second run. |

