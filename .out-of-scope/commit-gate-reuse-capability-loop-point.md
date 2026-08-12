# A parallel `commit_gates` config for artifact preconditions in `cmdCommit`

**Source:** [#3353](https://github.com/open-gsd/gsd-core/issues/3353)
**Decision:** wontfix — closed as filed; the mechanism already exists in the capability gate system
**Date:** 2026-08-11

## Proposal summary

#3353 asked for a declarative pre-commit gate evaluated inside `cmdCommit`
(`src/commands.cts`): a `commit_gates` array in `.planning/config.json` that matches files in the
commit's scope, runs a shell command against each match, blocks the commit on non-zero (before
staging, so a refusal leaves the index untouched), and is overridable via a CLI flag. The
motivation was concrete and real — a workflow can assert "do not commit while X holds" about an
artifact (e.g. an ungrounded `REVIEWS.md`), be entirely right, and watch the artifact get
committed anyway because the check lives only in the prompt and a model can report a stale or
skipped verdict as fresh.

This entry denies **the `commit_gates` config as filed.** It does not deny the underlying need.

## Why GSD does not own this (as filed)

- **The exact mechanism already exists in the capability system.** Since
  [#2008](https://github.com/open-gsd/gsd-core/issues/2008) / ADR-2008, a capability can declare a
  `gates` entry with `check.predicate.kind: "command-exit-zero"` — "run your command, block the
  loop on non-zero" — at a chosen loop point, with `blocking` and `onError` semantics and a `when`
  config-key gate. See
  [`docs/how-to/command-exit-zero-gate.md`](../docs/how-to/command-exit-zero-gate.md) and
  [`docs/reference/gate-predicates.md`](../docs/reference/gate-predicates.md). The proposed
  `commit_gates` shape (`command` + `block_on: "nonzero"` + match + override) is the same
  mechanism in a different config.
- **A second config would fragment the architecture.** `commit_gates` in `.planning/config.json`,
  fired from `cmdCommit`, would coexist with capability `gates` in `capability.json`, fired from
  the loop-resolver — two config locations, two override paths, two evaluators, and ambiguity
  about which fires when. GSD deliberately owns one gate system; the capability gate is it.
- **The right route is an extension of the existing system, not a parallel one.** There is **no
  `commit:pre` loop point today.** The 12 canonical loop points
  (`src/loop-resolver.cts` `CANONICAL_POINTS`: the `:pre`/`:post` pairs for `discuss`, `plan`,
  `verify`, and `ship`, plus the four `execute` points — `execute:pre`, `execute:wave:pre`,
  `execute:wave:post`, `execute:post`) do not include commit. The loop-point vocabulary is **closed but
  additive-only**
  ([`docs/reference/capability-manifest.md`](../docs/reference/capability-manifest.md)), so adding
  a `commit:pre` point — and wiring `cmdCommit` to invoke the loop-resolver there — lets any
  capability declare the existing `command-exit-zero` gate at commit time. That extends the system
  you have rather than building a second one beside it.
- **EoS (ADR-1239) is unaffected either way.** `cmdCommit` is engine-internal; a pre-commit gate
  touches none of the six host-integration interface points (command/dispatch/model/hooks/state/
  artifact are about host↔engine, not git internals). This is recorded only to head off the
  misread that this decision is an EoS constraint — it is a capability-architecture constraint.

## What this does NOT cover

This entry denies **a `commit_gates` config separate from the capability gate system.** It does
not deny, and must never be cited against:

- **Adding a `commit:pre` (and/or `commit:post`) loop extension point** so capabilities can
  declare `command-exit-zero` gates at commit time. This is the route the filing should take, and
  it is welcome as a capability-system proposal (new loop point + ADR-level schema note).
- **The companion defect.** [#3352](https://github.com/open-gsd/gsd-core/issues/3352) — reviewer
  evidence is never verified, raw per-lane output is `rm -rf`'d, and an ungrounded `REVIEWS.md`
  feeds `/gsd-plan-phase --reviews` — is confirmed-bug on its own merits and stays open. That a
  full fix will likely *use* a commit-point gate does not make the `commit_gates` config the right
  home for the gate mechanism.
- **New `check.predicate` kinds** added to the existing capability gate evaluator — a separate,
  valid extension path.
- **Hardening `cmdCommit`'s existing git-level checks** (gitignore, branching strategy, staging
  failures) — those are unrelated to declarative artifact preconditions.

## Re-open criteria

- A need is shown for a commit-time gate that the capability loop-point model genuinely cannot
  express — e.g. a precondition that must fire when *no* capability is installed and that cannot
  itself be a loop point. This is narrow: the `commit:pre` point + `command-exit-zero` predicate
  covers the stated case (run a checker on a matched artifact, block on non-zero), so re-opening
  requires the loop-point route to have been tried and found structurally insufficient.

## Related

- [#3352](https://github.com/open-gsd/gsd-core/issues/3352) — companion defect (confirmed-bug):
  ungrounded `REVIEWS.md` is never verified then deleted
- [#2008](https://github.com/open-gsd/gsd-core/issues/2008) / ADR-2008 — the `command-exit-zero`
  capability gate this decision points to
- [`docs/how-to/command-exit-zero-gate.md`](../docs/how-to/command-exit-zero-gate.md) — authoring
  recipe
- [`docs/reference/gate-predicates.md`](../docs/reference/gate-predicates.md) — gate predicate
  reference
- [`docs/reference/capability-manifest.md`](../docs/reference/capability-manifest.md) — the 12
  closed/additive-only loop points
- [ADR-1239](../docs/adr/1239-gsd-embeddable-orchestration-engine.md) — EoS (unaffected)
