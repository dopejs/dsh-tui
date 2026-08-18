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

