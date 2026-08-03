# Workflow fragments (reference)

> **Diátaxis quadrant:** Reference. This is the canonical specification of the
> in-file `<!-- gsd:section -->` marker grammar used to fragmentize GSD workflow
> markdown for per-runtime emission. For the surrounding seam (why it exists and
> how it composes with the shared budget composer), see
> [Architecture: Workflow Fragmentization and Emission](../ARCHITECTURE.md#workflow-fragmentization-and-emission-srcworkflow-fragmentscts-adr-1671)
> and [ADR-1671](../adr/1671-dynamic-context-management-platform.md) (open
> questions 1 and 2).

Workflow authors can mark one or more sections of a `gsd-core/workflows/*.md` file
so that `bin/install.js`'s emission path can compose them per runtime, and so that
a separate init-time seam can select which sections apply to one concrete
invocation — see [The manifest artifact and per-workflow
keying](#the-manifest-artifact-and-per-workflow-keying) below.

## Marker syntax

An open marker is a line whose only content (after trimming leading/trailing
whitespace) is:

```html
<!-- gsd:section id="<id>" when="<when>" -->
```

A close marker is a line whose only content is:

```html
<!-- /gsd:section -->
```

- Attribute order is free and inner spacing around `=` and between attributes
  is flexible.
- `id` must match `/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/` and must be unique
  within one file.
- `when` must be exactly one entry of the frozen vocabulary below — no
  operators, no negation, no nesting.
- Both `id` and `when` are **required** on every open marker; a marker missing
  either attribute fails closed (see [Fails closed](#fails-closed)).

Text between an open marker and its matching close marker is that section's
body, byte-for-byte (including its own line terminators). Text outside any
marker pair becomes an implicit "gap" fragment — the file's ordinary,
unmarked content — so a workflow with no markers at all parses to exactly one
gap fragment and composes back byte-identical to its source.

## The frozen `when=` vocabulary

`when=` takes exactly one of 26 atoms (widened from 4 to 14 via the ADR-1671
amendment for #2992, epic #1671 Phase 6.1, then from 14 to 19 via the
ADR-1671 amendment for #2993, epic #1671 Phase 6.2, then from 19 to 20 via
the ADR-1671 amendment for #2994, epic #1671 Phase 6.3, then from 20 to 23
via a further #2994 amendment fragmentizing `code-review.md` and
`complete-milestone.md`, then from 23 to 24 via a still further #2994
amendment fragmentizing `autonomous.md`, then from 24 to 26 via a still
further #2994 amendment fragmentizing `review.md` and
`discuss-phase-assumptions.md`):

| Value | Meaning |
|---|---|
| `always` | Section is always applicable. |
| `flag:--wave` | Applicable when the workflow runs with `--wave`. |
| `state:gap-closure-phase` | Applicable when the phase number is a gap-closure phase (has a decimal, e.g. `4.1`). |
| `state:has-prior-phases` | Applicable when prior phases (and their `VERIFICATION.md` files) exist. |
| `flag:--auto` | Applicable when the workflow runs with `--auto`. |
| `flag:--discuss` | Applicable when the workflow runs with `--discuss`. |
| `flag:--fix` | Applicable when the workflow runs with `--fix` (`code-review.md`'s resolved fix decision — `--fix` itself, or `--all`/`--auto` implying it via `code-review-flags.cjs`). |
| `flag:--forensic` | Applicable when the workflow runs with `--forensic`. |
| `flag:--full` | Applicable when the workflow runs with `--full`. |
| `flag:--ingest` | Applicable when the workflow runs with `--ingest <path-or-glob>`. |
| `flag:--prd` | Applicable when the workflow runs with `--prd <file>`. |
| `flag:--research` | Applicable when the workflow runs with `--research`. |
| `flag:--research-phase` | Applicable when the workflow runs with `--research-phase <N>`. A distinct atom from `flag:--research` above — neither aliases the other. |
| `flag:--reset-phase-numbers` | Applicable when the workflow runs with `--reset-phase-numbers`. |
| `flag:--reviews` | Applicable when the workflow runs with `--reviews`. |
| `flag:--validate` | Applicable when the workflow runs with `--validate`. |
| `state:auto-advance-active` | Applicable when `discuss-phase-assumptions.md`'s `auto_advance` step should dispatch — `--auto` flag OR a consolidated auto-mode config fact (see [Compound conditions are resolved in the fact, never the grammar](#compound-conditions-are-resolved-in-the-fact-never-the-grammar) below). |
| `state:chunked-mode` | Applicable when chunked planning mode is active — see [Compound conditions are resolved in the fact, never the grammar](#compound-conditions-are-resolved-in-the-fact-never-the-grammar) below. |
| `state:fallow-enabled` | Applicable when `.planning/config.json`'s `code_quality.fallow.enabled` is `true` (fail-closed default `false`). |
| `state:git-create-tag` | Applicable when `.planning/config.json`'s `git.create_tag` is not `false` (fail-OPEN default `true`). |
| `state:needs-codebase-map` | Applicable when a codebase map is needed (init-computed). |
| `state:phase-mvp-mode` | Applicable when the current phase's `ROADMAP.md` entry declares `**Mode:** mvp`. |
| `state:plan-strategy-converge` | Applicable when `autonomous.md`'s planning step should route through plan-review convergence instead of `gsd-plan-phase` — the workflow runs with `--converge`, or its documented alias `--cross-ai` (`autonomous.md`'s own `PLAN_STRATEGY` resolver folds both). |
| `state:reviewer-instances-configured` | Applicable when `.planning/config.json`'s `review.reviewer_instances` is present AND non-empty. |
| `state:ui-phase-active` | Applicable when the phase's active `plan:pre` loop hooks include the `ui-phase` step, OR the phase directory already contains a `*-UI-SPEC.md` file — see [Compound conditions are resolved in the fact, never the grammar](#compound-conditions-are-resolved-in-the-fact-never-the-grammar) below. |
| `state:worktrees-enabled` | Applicable when `.planning/config.json`'s `workflow.use_worktrees` is enabled. |

This list is **closed by design** (Greenspun's Tenth Rule): left open-ended,
`when=` would acquire boolean operators, negation, precedence, and
runtime/capability predicates one edit at a time, becoming an ad-hoc,
informally-specified applicability language. Widening the vocabulary is a
coordinated ADR amendment to ADR-1671, never an organic edit to the parser —
`when=` remains exactly one atom per marker: no operators, no negation, no
nesting, regardless of how many atoms the frozen list holds. An unknown value
still throws (see [Fails closed](#fails-closed)).

An atom only ships once it clears **two independent admission gates**, both
required:

1. **A named consuming section.** Some workflow's marked section actually
   needs the condition — an atom with no section that uses it is dead
   vocabulary, and dead vocabulary is how a closed list rots into an open
   one.
2. **A fact the init seam can actually compute.** Only a workflow with a
   dedicated `cmdInit*` entry point (see [The manifest
   artifact](#the-manifest-artifact-and-per-workflow-keying) below) can carry
   a manifest, and only a condition that entry point can resolve at init time
   — from parsed CLI options or from `.planning/` state — may become an atom.
   An atom without a computable fact would always evaluate `false`, so a
   section marked with it would silently never include: the exact
   silent-wrong-answer class this gate exists to prevent.

Two further atoms (`flag:--verify-only`, `state:is-monorepo`) satisfy gate 1
but not yet gate 2 — their workflow (`docs-update`) routes through shared
generic init entry points invoked by 20+ other workflows, so a dedicated
`cmdInit*` seam does not yet exist to compute their facts. They are withheld
pending that seam, not rejected. `flag:--fix`, `state:fallow-enabled`, and
`state:git-create-tag` were withheld for the same reason until a further
#2994 amendment gave `code-review` and `complete-milestone` their own
dedicated `cmdInit*` entry points (`cmdInitCodeReview`,
`cmdInitCompleteMilestone`) — see [Piloted on execute-phase.md, then rolled
out across the wired
workflows](#piloted-on-execute-phasemd-then-rolled-out-across-the-wired-workflows)
below. A third atom, originally surveyed as `flag:--converge`, was withheld
for the same reason and never shipped under that name: a still further
#2994 amendment gave `autonomous` its own dedicated `cmdInit*` entry point
(`cmdInitAutonomous`), and the atom that shipped is
`state:plan-strategy-converge` instead — `--cross-ai` is a documented alias
for `--converge` (`autonomous.md`'s own `PLAN_STRATEGY` resolver folds
both), so a `flag:--converge`-only atom would have left a `--cross-ai`-only
invocation silently excluded from the same sections. `state:reviewer-instances-configured`
and `state:auto-advance-active` were withheld the same way until a still
further #2994 amendment gave `review` and `discuss-phase-assumptions` their
own dedicated `cmdInit*` entry points (`cmdInitReview`,
`cmdInitDiscussPhaseAssumptions`).

### Compound conditions are resolved in the fact, never the grammar

`state:chunked-mode` looks, at the section-body level, like it should be a
compound condition: plan-phase's chunked planning mode activates on
`--chunked` **OR** `.planning/config.json`'s `workflow.plan_chunked` being
`true`. The vocabulary stays operator-free anyway, because the disjunction is
resolved **before** it ever reaches `when=` — the init seam
(`buildSectionManifestField` in `src/init.cts`) computes ONE boolean,
`InvocationFacts.chunkedMode = flags.has('--chunked') ||
readConfigJsonBoolean(cwd, ['workflow', 'plan_chunked'])`, and
`WHEN_PREDICATES['state:chunked-mode']` reads only that single field. The
marker grammar never sees `--chunked`, never sees the config key, and never
sees an `OR` — it sees exactly one atom with no operator, same as every other
entry in the frozen list.

This is the general rule for any future atom whose real-world trigger is
itself a compound expression: **compounding belongs in fact computation
(`src/init.cts`), never in the `when=` grammar (`src/workflow-fragments.cts` /
`src/section-manifest.cts`).** A condition that cannot be reduced to one
boolean fact computed ahead of evaluation is not eligible to become an atom —
widening the grammar itself to express `OR`/`AND`/negation is exactly the
Greenspun's Tenth Rule drift [The frozen `when=`
vocabulary](#the-frozen-when-vocabulary) above exists to prevent, regardless
of how reasonable a single compound condition looks in isolation.

`state:ui-phase-active` (#2994) is the same shape: `verify-work.md`'s
`automated_ui_verification` step originally computed its own OR at RUNTIME
(`UI_PHASE_ACTIVE` from `gsd_run loop render-hooks plan:pre` OR a `*-UI-SPEC.md`
file check). `cmdInitVerifyWork` now resolves the identical disjunction ahead
of time — `resolveLoopHooks({point: 'plan:pre', ...}).activeHooks` filtered to
`kind === 'step' && ref.skill === 'ui-phase'`, OR'd with a `*-UI-SPEC.md`
existence check under the phase directory — into `InvocationFacts.uiPhaseActive`,
so `WHEN_PREDICATES['state:ui-phase-active']` again reads only that one field.

`state:plan-strategy-converge` (#2994) is the same shape again:
`autonomous.md`'s own bash `PLAN_STRATEGY` resolver already folds `--converge`
OR its documented alias `--cross-ai` into a single `"converge"`/`"local"`
value at the top of the `initialize` step. `cmdInitAutonomous` mirrors that
identical disjunction — `flags.has('--converge') || flags.has('--cross-ai')`
— into `InvocationFacts.planStrategyConverge`, so
`WHEN_PREDICATES['state:plan-strategy-converge']` reads only that one field,
never `--converge`/`--cross-ai` separately.

`state:auto-advance-active` (#2994) is the same shape once more:
`discuss-phase-assumptions.md`'s own `auto_advance` step already resolves
`--auto` OR a consolidated `check auto-mode --pick active` fact (itself
`workflow._auto_chain_active` OR `workflow.auto_advance`) via a runtime
`gsd_run` call before deciding whether to dispatch. `cmdInitDiscussPhaseAssumptions`
mirrors that identical disjunction — `options['auto'] === true ||
readConfigJsonBoolean(cwd, ['workflow', '_auto_chain_active']) ||
readConfigJsonBoolean(cwd, ['workflow', 'auto_advance'])` — into
`InvocationFacts.autoAdvanceActive`, so `WHEN_PREDICATES['state:auto-advance-active']`
reads only that one field, never the flag and the two config keys separately.

## Fails closed

An authoring mistake throws at parse time, naming the source file and 1-based
line number, rather than being silently dropped or swallowed to end-of-file:

- Missing `id=` or `when=` attribute (`MISSING_ID`, `MISSING_WHEN`).
- `when=` value not in the frozen vocabulary above, including any boolean
  operator or negation form (`UNKNOWN_WHEN`).
- `id=` value that does not match the id grammar (`MALFORMED_ID`).
- Malformed attribute syntax on an open marker — the attribute text is not a
  run of well-formed `key="value"` tokens (e.g. an unterminated quote or a
  duplicate attribute key) (`MALFORMED_ATTRIBUTES`).
- An unrecognized attribute on an open marker (`UNRECOGNIZED_ATTRIBUTE`).
- A close marker carrying attributes (`CLOSE_WITH_ATTRIBUTES`).
- An unmatched close marker, i.e. close with no open (`UNMATCHED_CLOSE`).
- A nested marker, i.e. open marker while already inside an open section
  (`NESTED_SECTION`).
- A duplicate `id=` within one file (`DUPLICATE_ID`).
- An open marker with no matching close before end of file
  (`UNCLOSED_SECTION`).

An unrecognized `when=` is treated as an authoring instruction that must never
be silently ignored, not as a value to fail open on — this is deliberately
asymmetric with the marker *formatting* tolerance above (free attribute order,
flexible spacing), which is liberal by design.

## Markers are stripped at emit

Composition runs `parseWorkflowSections` → map sections to fragments → the
shared `context-composer.cjs` budget seam (every fragment uses the `verbatim`
strategy, so nothing is trimmed) → re-join fragment bodies in document order.
The marker lines themselves are never part of any fragment body, so the
composed output — and therefore every installed runtime artifact — contains
no `gsd:section` markers at all. An unmarked file composes to itself exactly;
a marked file composes to itself minus the marker line bytes.

Composition runs **before** the per-runtime converters (the `.claude/` →
`.windsurf/`-style path and reference rewrites), so a marker's `id`/`when`
attribute text is never exposed to a rewrite regex.

## Fenced and commented lookalikes are literal

A `<!-- gsd:section ... -->`-shaped line inside a fenced code block (three or
more backticks or tildes, CommonMark-style) is **not** a marker — it is
literal fence content, because workflows document their own marker syntax in
fenced examples (as in this page and in the workflow files themselves). The
same applies to a `gsd:section` mention inside an unrelated HTML comment, or
in prose/backtick text that never opens a real one-line comment. Fence and
comment detection run as a single interleaved left-to-right scan, mirroring
the discipline used by the `CONTEXT.md` predicate parser
(`src/context-predicates.cts`): while a fence is open, only a matching closer
can end it; while a comment is open, only `-->` can end it; an unclosed fence
running to end of file is not an error — everything after it is simply
literal.

The pre-existing `<!-- gsd:loop-host ... -->` marker family (consumed by
`scripts/gen-loop-host-contract.cjs`) is a different, already-established
marker and is never treated as a `gsd:section` marker.

## The manifest artifact and per-workflow keying

`bin/install.js`'s emission path always composes every fragment into the
output regardless of its `when=` value — marker lines are stripped, nothing
else changes there. Applicability selection is a separate, later seam:
`scripts/gen-section-manifest.cjs --write` scans `gsd-core/workflows/*.md` for
`gsd:section` markers and generates a committed artifact,
`gsd-core/workflows/section-manifest.json`, shaped as
`{"workflows": {"<workflow-name>": [{"id", "when", "read"}, ...], ...}}`,
where `<workflow-name>` is a source `.md` file's basename without extension
and `read` is the POSIX-normalized, repo-root-relative path of the step file
the section body was extracted to. This is a per-workflow superset of the
pre-#2992 shape, which was a single flat `{"sections": [...]}` array with no
workflow key — that shape is now rejected outright rather than mis-parsed, so
a stale committed artifact can never be silently attributed to whichever
workflow asks first.

A workflow key's **presence vs. absence is meaningful, not cosmetic**:

- The key is **absent** when the workflow has zero marked sections. A caller
  for that workflow must treat this as degraded/unknown (`null`) — safe
  superset, read everything.
- The key is **present with an empty array** when the workflow's sections
  were evaluated and none applied to this invocation — genuinely nothing to
  read, not "unknown."

Collapsing these two states inverts behavior on the degraded path: `null`
means "I don't know, so include everything"; `[]` means "I computed this,
and the answer is nothing."

At init time, a separate pure evaluator, `src/section-manifest.cts`
(`selectSections`), partitions a workflow's manifest sections into
`included`/`excluded` id lists against one invocation's
`InvocationFacts` — `{flags, phaseNumber, hasPriorPhases, needsCodebaseMap?,
phaseMvpMode?, worktreesEnabled?, chunkedMode?, uiPhaseActive?, fallowEnabled?,
gitCreateTag?, planStrategyConverge?, reviewerInstancesConfigured?,
autoAdvanceActive?}`. Only a workflow with a **dedicated
`cmdInit*` entry point** in `src/init.cts` can have this evaluation run for
it, because only that entry point can assemble `InvocationFacts` from its own
parsed CLI options and `.planning/` state reads — this is admission gate 2
from [The frozen `when=` vocabulary](#the-frozen-when-vocabulary) above,
applied per-workflow rather than per-atom. Twelve entry points are wired
today: `execute-phase`, `plan-phase`, `new-project`, `new-milestone`,
`quick`, `progress`, `verify-work`, `code-review`, `complete-milestone`,
`autonomous`, `review`, and `discuss-phase-assumptions`.

`InvocationFacts.flags` is a `ReadonlySet<string>` of the literal `--<name>`
tokens seen on the invocation, and **membership is token-presence, not
value-truthiness**. This matters because `parseNamedArgs`'s `booleanFlags`
always materializes the key in its result object — `true` when the token was
seen, `false` otherwise, never `undefined`. A caller that passed a
boolean-flag's own `false` straight through as an "option value" would add it
to `flags` anyway (any non-`undefined` value counts as present for a
*value* flag), making that `flag:` atom permanently true regardless of the
actual command line — the fix is that every boolean-flag call site folds its
own `false` into `undefined` (`namedArgs['wave'] || undefined`) before
handing options to the facts builder, so `flags` only ever contains tokens
that were actually seen.

## Piloted on execute-phase.md, then rolled out across the wired workflows

Twelve workflows carry markers today, all of them the workflows with a
dedicated `cmdInit*` entry point (see [The manifest artifact](#the-manifest-artifact-and-per-workflow-keying)
above): `gsd-core/workflows/execute-phase.md` (the #2930/Phase-3 pilot),
`gsd-core/workflows/plan-phase.md` (#2993, epic #1671 Phase 6.2),
`gsd-core/workflows/progress.md`, `gsd-core/workflows/new-project.md`,
`gsd-core/workflows/quick.md`, `gsd-core/workflows/new-milestone.md` (those
four, #2994, epic #1671 Phase 6.3), `gsd-core/workflows/verify-work.md`
(also #2994, epic #1671 Phase 6.3), `gsd-core/workflows/code-review.md` /
`gsd-core/workflows/complete-milestone.md` (a further #2994 amendment, epic
#1671 Phase 6.3), `gsd-core/workflows/autonomous.md` (a still further
#2994 amendment, epic #1671 Phase 6.3), and `gsd-core/workflows/review.md` /
`gsd-core/workflows/discuss-phase-assumptions.md` (a still further #2994
amendment, epic #1671 Phase 6.3). The marker grammar and composer seam
are general-purpose across any workflow file; rollout to the remaining
`docs-update` workflow is gated on that workflow gaining its own dedicated
`cmdInit*` entry point (see the two-atoms-withheld note in [The frozen
`when=` vocabulary](#the-frozen-when-vocabulary) above), not scheduled as
later work on the marker grammar itself.

`execute-phase.md` marks three `<step>` blocks: `partial-wave`
(`flag:--wave`), `gap-closure-artifacts` (`state:gap-closure-phase`), and
`regression-gate` (`state:has-prior-phases`).

`plan-phase.md` marks six sections: `reviews-prerequisite` (`flag:--reviews`),
`prd-express-gate` (`flag:--prd`), `adr-ingest-express-path` (`flag:--ingest`),
`research-only-modifiers` and `research-only-early-exit` (both
`flag:--research-phase` — two consumers sharing one atom, gated by the same
`RESEARCH_ONLY` condition, so they include/exclude together), and
`chunked-planning-mode` (`state:chunked-mode`).

`progress.md` marks two sections: `forensic-audit` (`flag:--forensic`, #2994
forensic audit) and `mvp-display` (`state:phase-mvp-mode`). `mvp-display`'s
own body used to re-resolve its own gating fact via a `gsd_run query
phase.mvp-mode` call — circular, since a section's body re-deriving the exact
condition that gated its own inclusion is self-disabling the moment the init
seam's computation and the body's computation drift. `cmdInitProgress` now
computes `phaseMvpMode` for the CURRENT phase directly (threading a real
`phase_number` into `buildSectionManifestField`, where before it passed
`null` and the fact was permanently `false`) and exposes it as a top-level
`phase_mvp_mode` init-bundle field, so the step body consumes an
already-resolved fact instead of recomputing it.

`new-project.md` marks two sections, both `flag:--auto`: `auto-mode-detection`
(the `<auto_mode>` tag itself stays outside the marker — only its body is
extracted) and `auto-mode-config` (`## 2a. Auto Mode Config`).

`quick.md` marks five sections: `discussion-phase` (`flag:--discuss`),
`research-phase` (`flag:--research`), `plan-checker-loop` and
`quick-verification` (both `flag:--validate` — two consumers sharing one
atom, mirroring `plan-phase.md`'s `research-only-*` pair), and
`worktree-pre-dispatch-commit` (`state:worktrees-enabled`). `quick.md`'s
`--full` flag IMPLIES `--discuss`/`--research`/`--validate` — folded into the
facts inside `cmdInitQuick` (mirroring `state:chunked-mode`'s disjunction
fold) before `buildSectionManifestField` builds its flags Set, so a bare
`--full` invocation still includes the three flag-gated sections without the
grammar ever seeing an OR.

`new-milestone.md` marks one section: `reset-phase-safety`
(`flag:--reset-phase-numbers`).

`verify-work.md` marks two sections: `automated-ui-verification`
(the new `state:ui-phase-active`, #2994 — see [Compound conditions are
resolved in the fact, never the grammar](#compound-conditions-are-resolved-in-the-fact-never-the-grammar)
above) and `mvp-uat-framing` (`state:phase-mvp-mode`, sharing the atom
already computed for `progress.md`'s `mvp-display`). `mvp-uat-framing`'s
extraction is narrower than `progress.md`'s `mvp-display`: only the
true-branch prose (the three ordered UAT sections plus the User Story format
guard) moves into the step file — the false-branch note ("When `MVP_MODE=false`
… fall back to the standard UAT generation path") stays OUTSIDE the marker,
directly after it, because gating it away with the rest of the section would
delete the exact text needed on every invocation where the atom is `false`
(the common, non-MVP case). Unlike `progress.md`'s `mvp-display`, `verify-work.md`
keeps its own `MVP_MODE=$(gsd_run query phase.mvp-mode ...)` runtime resolver
(in the unconditional `initialize` step, not inside the gated section) — it is
not circular/self-disabling the way `progress.md`'s inline resolver was,
because the un-marked false-branch note and the step-file prose both still
reference `$MVP_MODE` as a runtime variable, so the resolver keeps a live
consumer outside the gate.

`code-review.md` marks two sections: `structural-pre-pass` (`state:fallow-enabled`)
and `dispatch-fix` (`flag:--fix`). `structural-pre-pass`'s own body used to
re-resolve its own gating fact via four `gsd_run query config-get
code_quality.fallow.*` calls — circular, for the same reason `progress.md`'s
pre-hoist `mvp-display` was: a section's body re-deriving the exact condition
that gated its own inclusion is self-disabling the moment the init seam's
computation and the body's computation drift. `cmdInitCodeReview` now resolves
`code_quality.fallow.{enabled,scope,profile,mcp}` once (`detectFallowConfig`,
`src/init.cts`) and exposes them as top-level `fallow_enabled`/`fallow_scope`/
`fallow_profile`/`fallow_mcp`/`fallow_max_crap` init-bundle fields; the
unconditional part of the `structural_pre_pass` step now just parses those
fields, and only the fallow-binary-resolve-and-execute portion (which produces
`FALLOW.json`) is gated behind the marker — the `FALLOW_JSON_PATH=""`
disabled-path fallback stays OUTSIDE the marker, directly after it, for the
same reason `verify-work.md`'s MVP false-branch note does (deleting it would
break the common, fallow-disabled case). `dispatch-fix` moves the entire
`--fix`-gated step wholesale (mirroring `progress.md`'s `forensic-audit`
extraction) — `code-review.md`'s `initialize` step now resolves the RESOLVED
fix decision (`--fix` itself, or `--all`/`--auto` implying it, via
`code-review-flags.cjs`) before the `init.code-review` call, so the
section-manifest gate matches the flags module's own implication logic rather
than a raw `--fix` token scan.

`complete-milestone.md` marks one section: `git-tag` (`state:git-create-tag`).
The `git_tag` step's own `<config-check>` sub-tag used to re-resolve
`git.create_tag` via `gsd-tools.cjs query config-get` to decide whether to
skip the step — again a section (here, a whole step) gating its own inclusion
on a fact its own body computed. `cmdInitCompleteMilestone` now resolves it
once (`detectGitCreateTag`, `src/init.cts`, fail-OPEN default `true` — an
unset key means "create the tag", the inverse polarity of `detectFallowConfig`'s
fail-closed default, mirroring the two source resolvers' own opposite
defaults) and exposes it as the init-bundle's `git_create_tag` field; the
entire `git_tag` step moves to its step file wholesale, with no
`<config-check>` left to re-derive. `complete-milestone.md` gains an
ADDITIVE `init.complete-milestone` call (in the `handle_branches` step,
alongside its pre-existing `init.manager` and `init.execute-phase` calls,
neither of which is removed) purely to carry `git_create_tag` and
`section_manifest` — it has no phase-listing logic of its own to delegate.

`autonomous.md` marks five sections, all sharing the single
`state:plan-strategy-converge` atom (legal and precedented — `plan-phase.md`'s
`research-only-*` pair already shares `flag:--research-phase`): `converge-fail-fast`
(the `workflow.plan_review_convergence` feature-gate check, split out of the
surrounding `CONVERGENCE_ARGS` bash block — that block's reviewer-flag/`--max-cycles`
parsing stays UNGATED, directly before the marker, because it always needs to
run regardless of `PLAN_STRATEGY`, and only the `if [ "$PLAN_STRATEGY" =
"converge" ]` fail-fast check moves into the step file), `converge-banner`
(a single display line — still a legitimate section per [Marker
syntax](#marker-syntax) above; `scripts/gen-section-manifest.cjs`'s
`FAIL_MISSING_STEP_FILE` check requires a step file for every explicit marker
regardless of body size, so the stub+step-file round trip is not optional
here even though the body is trivially small), `converge-dispatch-bg` and
`converge-dispatch-inline` (the `PLAN_STRATEGY=converge` branch of step 3b's
background/inline `FLATTEN` dispatch — an ORTHOGONAL condition interleaved in
the same list; each converge branch is independently contiguous and the
sibling `- Otherwise, print: ...`/`- Otherwise (local planning):` fallback
bullets stay OUTSIDE the marker, immediately after it, because they are the
`PLAN_STRATEGY=local` default that must always render), and `converge-loop`
(the unconditional-`INTERACTIVE` bottom-of-3b convergence dispatch, with the
`PLAN_STRATEGY=local` regular-planner fallback again staying outside).
`autonomous.md` keeps its own bash `PLAN_STRATEGY` resolver (`"local"` vs.
`"converge"`, folding `--converge` OR `--cross-ai`) in the UNCONDITIONAL
`initialize` step — never moved or removed — because ungated content later
in the same step (the "local" planning bullets) still references
`$PLAN_STRATEGY` as a runtime variable, same discipline as
`verify-work.md`'s retained `$MVP_MODE` resolver. `cmdInitAutonomous` mirrors
the identical disjunction into `InvocationFacts.planStrategyConverge`, and
`autonomous.md` gains an ADDITIVE `init.autonomous` call (in the
`initialize` step, alongside its pre-existing `init.milestone-op`,
`init.manager`, and `init.phase-op` calls — CRITICAL blast radius, none
removed, none modified) purely to carry `section_manifest`; like
`complete-milestone.md`'s entry point, it has no phase-listing logic of its
own to delegate.

`review.md` marks two sections, both sharing the single
`state:reviewer-instances-configured` atom (legal and precedented —
`plan-phase.md`'s `research-only-*` pair already shares
`flag:--research-phase`): `reviewer-instances-note-1` and
`reviewer-instances-note-2`, two peripheral additive notes in the
`detect_clis` and `invoke_reviewers` steps respectively. Neither note is
part of the workflow's core reviewer-lane dispatch — that dispatch is the
workflow's primary always-evaluated logic and is never gated. `review.md`
previously routed through the shared, 20+-caller `init.phase-op`, reading
only 3 of its ~60 fields (`phase_dir`, `phase_number`, `padded_phase`);
`cmdInitReview` now resolves those 3 fields itself via the same
`guardedFindPhase`/`guardedGetRoadmapPhase` primitives, plus the
`review.reviewer_instances` config-presence fact (reusing
`readConfigJsonValue`, added for `detectFallowConfig` — no second config
reader).

`discuss-phase-assumptions.md` marks one section: `auto-advance-dispatch`
(`state:auto-advance-active`), inside the `auto_advance` step. The step's
own `--auto`-flag parse, chain-flag sync, and consolidated `AUTO_MODE`
resolver (all of which must always run) stay OUTSIDE the marker; only the
flag-present display-banner-and-launch body is gated, and the flag-absent
"End here" fallback stays OUTSIDE the marker too, directly after it — gating
the whole step would delete the fallback text needed exactly when `--auto`
is absent, the same class of hazard `verify-work.md`'s MVP false-branch note
and `code-review.md`'s fallow-disabled fallback both document. `discuss-phase-assumptions.md`
previously routed through `init.phase-op`, reading 14 of its fields;
`cmdInitDiscussPhaseAssumptions` now resolves those 14 fields itself (via
the same shared primitives, reproducing `cmdInitPhaseOp`'s archived/not-found
fallback shape), plus `state:auto-advance-active` — `--auto` flag OR a
consolidated auto-mode config fact, resolved to one boolean the same way
`state:chunked-mode` is.

**`plan-phase.md` was originally retargeted away from the #2930 pilot,
then fragmentized here once the blocker cleared.** Issue #2930's own
motivating mutually-exclusive branches (`--prd`, `--ingest`, `--mvp`,
`--reviews`) all live in `plan-phase.md`, not `execute-phase.md`, but at the
time `plan-phase.md` sat only 36 B under an independent, pre-existing size
gate (`tests/phase6-capstone-conformance.test.cjs`'s `PRE_PHASE6`, an
ADR-857 Phase-6 completion property) and could not absorb any marker
overhead at all. #2993 resolves this **because fragmentizing is net-negative
on host source, not net-positive**: each gated body moves from always-inline
prose to a `gsd-core/workflows/plan-phase/steps/<id>.md` step file, leaving
only a ~200 B conditional-read stub behind — the six extractions trim
`plan-phase.md` from 94,483 B to 87,575 B, moving the file from 36 B of
`PRE_PHASE6` headroom to roughly 7,000 B, well clear of the cap.

`--mvp` remains unmarkable by this grammar, unchanged by #2993 and by
deliberate ADR-1671 decision: its content in `plan-phase.md` is INTERLEAVED
with other flags rather than living in its own contiguous section (`MVP_MODE`
resolution shares a single bash block with `--tdd`, `--no-tracer`, and
`--no-reversibility-gates` handling, and elsewhere it is inline
`${MVP_MODE === 'true' ? ... }` template interpolation embedded inside the
planner prompt) — the marker grammar is closed, non-nesting, and whole-line
(see [Marker syntax](#marker-syntax) above), with no way to wrap part of a
line or split a shared conditional block without either corrupting the
conditional or bundling unrelated flags into one section. See
[ADR-1671](../adr/1671-dynamic-context-management-platform.md) open
question 1's resolution for the full record.

## Related

- [ADR-1671](../adr/1671-dynamic-context-management-platform.md) — the
  platform decision record, including open questions 1 (fragment unit) and 2
  (build-time vs. run-time emission), both resolved by this phase.
- [Architecture: Workflow Fragmentization and Emission](../ARCHITECTURE.md#workflow-fragmentization-and-emission-srcworkflow-fragmentscts-adr-1671).
- `src/workflow-fragments.cts` — the compiled parser/composer source.
- `src/context-composer.cts` — the shared budget-composition seam consumed by
  `composeWorkflow`.
- `src/section-manifest.cts` — the pure `when=` evaluator (`selectSections`,
  `InvocationFacts`) consumed by the init seam.
- `scripts/gen-section-manifest.cjs` — generates the committed
  `gsd-core/workflows/section-manifest.json` artifact from markers.
- `src/init.cts` — `buildSectionManifestField` and the ten wired
  `cmdInit*` entry points.
