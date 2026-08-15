# Upstream compatibility

## Baseline

The initial design was inspected against DeepSeek Harness:

| Field | Value |
| --- | --- |
| Repository | `deepseek-ai/deepseek-harness` |
| Commit | `47f943859bef60e4160492346772ded9b24f765a` |
| Package version | `0.1.0-rc.5` |
| Inspection date | 2026-08-14 |
| Node engine | `^22.19.0 || >=24.0.0` |
| Package manager | `pnpm@11.7.0` |
| Cordis | `4.0.1` |
| Cordis loader | `1.0.2` |

Harness is a developer preview. The runtime package must pin or declare a narrow
tested peer range; semver compatibility is not assumed across release candidates.

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
- `approval/request` answerer waterfall.
- `ctx.userQuestions.registerProvider()`.
- `ctx.sessionPersistence.list()` / `inspect()` where session browsing needs
  them; resume itself remains owned by `ctx.agents.resume()`.
- `ctx.sessionProjections.snapshot()` / `onChanged()` for optional domain views.

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
| `0.0.0` fixture | `47f9438` / `0.1.0-rc.5` | Cordis lifecycle verified | Exact Cordis/loader peers; agent services not integrated yet. |

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
