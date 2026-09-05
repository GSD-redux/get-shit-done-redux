# ADR-4030: Typed invocation context on `loop render-hooks`

- **Status:** Proposed
- **Date:** 2026-09-05
- **Issue:** #4030
- **Amends:** [ADR-857](857-capability-system.md) — adds a typed `context` field to the `loop render-hooks` envelope the Ratification section names as shipped (the 12 Loop Extension Points' render-hook call sites).
- **Implementation:** Additive, optional field on the existing `loop render-hooks` CLI and JSON envelope ([ADR-857](857-capability-system.md)). No new command, dependency, or persisted state.

## Decision

`cmdLoopRenderHooks` (`src/loop-resolver.cts`) accepts one new optional flag,
`--phase <token>`, supplied by the invoking workflow at phase-scoped points
(`plan:pre`, `plan:post`, `execute:wave:pre`, `execute:wave:post`,
`execute:post`, `verify:pre`, `verify:post`). `<token>` uses the same
bare-tolerant grammar every phase-scoped workflow already holds
(`phase_number` from its own `init.*` query — e.g. `"05"`), not the bracket
display form. Workstream scoping needs no new plumbing: `gsd-tools.cjs`
already resolves `--ws`/`GSD_WORKSTREAM` generically for every command before
dispatch (`resolveActiveWorkstream` / `applyResolvedWorkstreamEnv`). Whether a
call site *also* passes `${GSD_WS}` explicitly follows each file's own existing
convention for phase-resolving `gsd_run` calls, rather than one blanket rule:
`verify-work.md` passes it (its `query init.verify-work` does), `execute-phase.md`
does not (its `query init.execute-phase` does not).

The resolver does not accept a caller-supplied directory. It resolves
`phaseDir` itself by calling `guardedFindPhase(cwd, phase,
config.project_code)` (`src/phase-locator.cts`) — the same function `init.*`
uses, not the bare `findPhaseInternal` it wraps — and surfaces both as an
additive `context: { phase, phaseDir }` field, where `phaseDir` is the
literal on-disk directory name the underlying `findPhaseInternal` matched
(`toPosixPath(path.join(relBase, match))`), never a caller-supplied string.
Because the result is drawn from a `readdirSync` listing filtered by
`matchPhaseDirs`, path traversal, absolute-path substitution, and symlink
escape are structurally unreachable — there is no path string to validate.
Going through `guardedFindPhase` rather than the bare primitive also carries
its `isForeignPrefixedPhaseQuery` check (`src/phase-id.cts`, the #2056/#2105
guard): a `project_code`-scoped repo gets the identical #2237 foreign-prefix
protection `init.*` already has, rather than reopening it for this new call
site — confirmed with a hostile-token test (`tests/loop-render-hooks.test.cjs`).

`guardedFindPhase` does not throw on a missing, ambiguous, or foreign-prefixed
phase — it returns `null`/`found: false` (with `ambiguous_matches` when more
than one directory matches). `cmdLoopRenderHooks` mirrors `cmdInitPhaseOp`'s
existing #2237 handling of that same shape: `context` is omitted and a
warning is appended to the envelope's existing `warnings` array, not thrown
or exited non-zero — `--phase` degrades to "no context", it does not fail
the render. Omitting `--phase` entirely preserves today's `{ point,
activeHooks, rendered, warnings? }` shape exactly.

Generic `step`/`gate`/`contribution` dispatch (`gsd-core/references/loop-hook-dispatch.md`)
projects `context.phase` / `context.phaseDir` into the dispatched handler's
invocation (CLI arg, agent prompt, or command payload per handler kind).
**Invocation context is authoritative for task-local phase identity.** A
capability MUST use it over `STATE.current_phase` or artifact-order/mtime
inference when both are available — `STATE.current_phase` is project lifecycle
status, not a claim about which phase the current invocation is scoped to, and
diverges from it whenever one phase plans/verifies while another executes.

## Rationale

- **The gap is narrower than "no context exists," and that is exactly why it
  is easy to miss.** `loop-hook-dispatch.md`'s `step` → `ref.command` rule
  already does `gsd_run ${ref.command} --phase "${PHASE_NUMBER}" --raw` today
  — but `${PHASE_NUMBER}` is whatever shell variable the host workflow
  happens to hold at that call site, unvalidated and uncorrelated with the
  resolved point. Before this ADR, the `ref.skill`/`ref.agent` bullets in
  `loop-hook-dispatch.md` said nothing about a phase argument at all — so any
  point without its own bespoke, per-workflow phase-filling prose gets no
  phase argument, silently. This is not hypothetical: `nyquist`'s
  `verify:post` step (`capabilities/nyquist/capability.json`) is
  `{"ref":{"skill":"validate-phase"}}`, dispatched through `verify-work.md`'s
  generic `kind == "step"` loop (no bespoke phase-filling there, unlike
  `plan-phase.md`). `gsd-validate-phase`'s own argument contract —
  `argument-hint: "[phase number]", "Phase: $ARGUMENTS — optional, defaults
  to last completed phase"` — silently falls back to artifact-order inference
  exactly like the originating issue describes, precisely because the
  generic dispatch path gave it nothing else to use. `plan-phase.md`'s
  `plan:pre`/`plan:post`
  points are the exception, not the rule: its own "Generic step hook
  dispatch contract" (§5.6) already hand-fills `${PHASE}` for `ref.skill`
  args and `ref.agent` prompts, and does so correctly, since `$PHASE` there
  is the same already-`guardedFindPhase`-resolved value this ADR's `context`
  field independently re-derives — so it is unaffected by this ADR either
  way and is left as-is. Formalizing `context` as a resolver-derived,
  validated envelope field closes the gap with one seam that every point can
  rely on, instead of requiring each workflow to hand-roll its own
  phase-filling prose the way `plan-phase.md` happened to.
- **Rejected: doc-only convention (no code change).** Extend the
  `ref.skill`/`ref.agent` bullets in `loop-hook-dispatch.md` to instruct each
  host workflow to pass its own already-known `$PHASE`/`$PHASE_DIR` into the
  dispatched prompt/command by hand. Rejected because this is a prose
  contract every host workflow and every runtime adapter would re-derive or
  paraphrase independently — precisely the per-capability/per-adapter
  inference the issue rejects — and a non-Claude runtime adapter projecting
  the envelope onto a native hook payload has no prose to read from. A typed
  field is the only shape an adapter can project.
- **Rejected: caller-supplied `phaseDir` alongside `phase`.** An earlier draft
  of this ADR had the caller pass both `--phase` and `--phase-dir`,
  independently validated with a hand-rolled path-confinement check. Dropped
  because (a) it requires inventing new containment logic where
  `guardedFindPhase` already exists and is exported, duplicating an
  invariant this repo's own [ADR-3473](3473-enforcement-by-construction.md)
  ("one owner per invariant") argues against, and (b) it trusts the caller
  to supply a correlated pair with no cross-check, where deriving `phaseDir`
  from `phase` makes an incoherent pair structurally impossible instead of
  merely validated.
- **Evidence.** This is a property gap verified in-tree (above), not a
  single external bug report — the originating issue cites one, but that
  report cannot on its own distinguish "wrong phase received" from "hook
  mis-dispatched" (a separate, already-tracked concern in #3606/#3647), so
  it is not relied on here as the sole justification.

## Revisit if

A later ADR generalizes loop invocation context beyond `phase`/`phaseDir`
(e.g. workstream, milestone) — this ADR's `context` field would extend, not
be replaced, since the additive-envelope shape already accommodates new keys.

## References

- [ADR-857](857-capability-system.md) — capability system / loop extension points this field extends.
- [ADR-3473](3473-enforcement-by-construction.md) — "one owner per invariant"; why `phaseDir` is derived, not caller-supplied.
- `gsd-core/references/loop-hook-dispatch.md` — generic dispatch contract this ADR's `context` field extends.
- `src/phase-locator.cts`'s `guardedFindPhase` / `findPhaseInternal` / `searchPhaseInDir` — existing phase-token-to-directory resolution this ADR reuses rather than re-implements. #4030 moved `guardedFindPhase` here from `src/init.cts` so its second consumer does not have to reach through the first.

## Out of scope

`gate-predicate-evaluator.cts` already accepts a `--phase-dir` value on the
unrelated `check predicate` command and does not validate it. Pre-existing,
not introduced or fixed by this ADR; left as-is.
