# Admit gsd-doc-writer / gsd-roadmapper as loop-hook contribution roles

**Source:** [#4286](https://github.com/open-gsd/gsd-core/issues/4286)
**Decision:** wontfix — closed as unspecified, revisit if a concrete design is proposed
**Date:** 2026-09-05

## Proposal summary

`bin/lib/loop-host-contract.cjs` enumerates the contribution roles admissible at each of the
12 loop hook points (discuss/plan/execute/verify/ship pre/post): `orchestrator`, `researcher`,
`planner`, `checker`, `executor`, `verifier`. `doc-writer` and `roadmapper` appear in none of
them, so a capability cannot contribute a prompt fragment to `gsd-doc-writer` or
`gsd-roadmapper` at any hook point — the capability validator rejects any contribution naming
a role the host doesn't declare. The reporter maintains a documentation-standard capability and
wants to reach both agents the same way existing capabilities reach `planner`/`checker`/
`executor`, since the only current route (`agent_skills` in `.planning/config.json`) is
per-project, gets silently shadowed once a project config exists (so `~/.gsd/defaults.json`
stops supplying it), and has been observed reverted by routine working-tree operations without
anyone noticing. Two options were offered: (1) admit the two roles as contribution targets, or
(2) document per-project `agent_skills` as the intended mechanism if that's deliberate.

## Why GSD does not own this (as filed)

- **The request's premise doesn't hold.** Investigated via Memtrace (`find_code`) plus a direct
  read of `references/loop-hook-dispatch.md`: `gsd-roadmapper` is dispatched only from the
  `new-project` / `new-milestone` / `ingest-docs` workflows, and `gsd-doc-writer` only from
  `docs-update` — none of which are among the 12 loop points the capability-contribution
  mechanism (`activeHooks` / `byLoopPoint`) actually reaches. Admitting `doc-writer`/`roadmapper`
  as `agentRoles` at `plan:pre`/`plan:post` etc. would not actually let a capability contribute
  to these agents, because they are never dispatched from those points in the first place. The
  fix as filed (add two entries to an existing enum) doesn't solve the problem it names.
- **No concrete design exists to review.** The real question underneath this report — should
  the standalone workflows that *do* invoke these two agents (`new-project`, `new-milestone`,
  `docs-update`) get their own capability-contribution points, separate from the 12-point loop
  contract? — is a legitimate, unanswered architectural question, but nobody has proposed what
  that would look like: which points, what shape, how it interacts with `agent_skills` shadowing.
  A Feature Review needs a proposal to evaluate; this issue surfaced a real gap without one.

## What this does NOT cover

This decision does not deny the underlying gap. It does not cover, and does not prejudge:

- A concrete proposal for giving `new-project`/`new-milestone`/`docs-update` (or any other
  standalone, non-loop workflow) their own capability-contribution points.
- Fixing the `agent_skills` per-project shadowing behavior itself (documented at
  `bin/lib/config-loader.cjs:335`/`:1023`, `_warnShadowedGlobalDefaults`) as its own, narrower
  ask — that's a real defect-shaped gap independent of the contribution-role question.
- Any request to extend `agentRoles` at one of the 12 *existing* loop points for an agent that
  genuinely is dispatched from that point.

## Re-open criteria

Revisit if a contributor proposes a concrete design for reaching `doc-writer`/`roadmapper` (or
other standalone-workflow agents) that:

- Names the actual dispatch points on the standalone workflows themselves (not the unrelated
  12-point loop contract), and
- Specifies how it composes with or replaces the existing per-project `agent_skills` mechanism
  rather than adding a third parallel route.

## Related

- `references/loop-hook-dispatch.md` — the 12-point loop contract this request's premise
  incorrectly assumed `doc-writer`/`roadmapper` participate in.
- `bin/lib/config-loader.cjs:335`, `:1023` — `agent_skills` global-defaults shadowing behavior
  the reporter flagged as a contributing pain point.
