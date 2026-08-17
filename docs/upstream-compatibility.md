# Upstream compatibility

## Baseline

The initial design was inspected against DeepSeek Harness:

| Field | Value |
| --- | --- |
| Repository | `deepseek-ai/deepseek-harness` |
| Commit | `47f943859bef60e4160492346772ded9b24f765a` |
| Source manifest version | `0.1.0-rc.5` |
| Published package baseline | `0.1.0-rc.6` |
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

On Linux, Harness `0.1.0-rc.6` loads `node-pty@1.1.0`, whose npm artifact must
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
| Remote TUI attachment | SDK/API packages exist for other products | Out of scope until a second concrete transport and ADR exist |

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
| `0.1.0-rc.1` | `47f9438` / npm `0.1.0-rc.6` | Release-candidate verification | Exact peers; public exports only; create/resume, transcript, tools, commands, approval/questions, clean tarball install, and PTY teardown covered. |

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
