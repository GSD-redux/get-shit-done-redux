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

`when=` takes exactly one of 19 atoms (widened from 4 to 14 via the ADR-1671
amendment for #2992, epic #1671 Phase 6.1, then from 14 to 19 via the
ADR-1671 amendment for #2993, epic #1671 Phase 6.2):

| Value | Meaning |
|---|---|
| `always` | Section is always applicable. |
| `flag:--wave` | Applicable when the workflow runs with `--wave`. |
| `state:gap-closure-phase` | Applicable when the phase number is a gap-closure phase (has a decimal, e.g. `4.1`). |
| `state:has-prior-phases` | Applicable when prior phases (and their `VERIFICATION.md` files) exist. |
| `flag:--auto` | Applicable when the workflow runs with `--auto`. |
| `flag:--discuss` | Applicable when the workflow runs with `--discuss`. |
| `flag:--forensic` | Applicable when the workflow runs with `--forensic`. |
| `flag:--full` | Applicable when the workflow runs with `--full`. |
| `flag:--ingest` | Applicable when the workflow runs with `--ingest <path-or-glob>`. |
| `flag:--prd` | Applicable when the workflow runs with `--prd <file>`. |
| `flag:--research` | Applicable when the workflow runs with `--research`. |
| `flag:--research-phase` | Applicable when the workflow runs with `--research-phase <N>`. A distinct atom from `flag:--research` above — neither aliases the other. |
| `flag:--reset-phase-numbers` | Applicable when the workflow runs with `--reset-phase-numbers`. |
| `flag:--reviews` | Applicable when the workflow runs with `--reviews`. |
| `flag:--validate` | Applicable when the workflow runs with `--validate`. |
| `state:chunked-mode` | Applicable when chunked planning mode is active — see [Compound conditions are resolved in the fact, never the grammar](#compound-conditions-are-resolved-in-the-fact-never-the-grammar) below. |
| `state:needs-codebase-map` | Applicable when a codebase map is needed (init-computed). |
| `state:phase-mvp-mode` | Applicable when the current phase's `ROADMAP.md` entry declares `**Mode:** mvp`. |
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

Six further atoms (`flag:--converge`, `flag:--fix`, `flag:--verify-only`,
`state:fallow-enabled`, `state:git-create-tag`, `state:is-monorepo`) satisfy
gate 1 but not yet gate 2 — their workflows (`autonomous`, `code-review`,
`complete-milestone`, `docs-update`) route through shared generic init entry
points invoked by 20+ other workflows, so a dedicated `cmdInit*` seam does
not yet exist to compute their facts. They are withheld pending that seam,
not rejected.

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
phaseMvpMode?, worktreesEnabled?, chunkedMode?}`. Only a workflow with a **dedicated
`cmdInit*` entry point** in `src/init.cts` can have this evaluation run for
it, because only that entry point can assemble `InvocationFacts` from its own
parsed CLI options and `.planning/` state reads — this is admission gate 2
from [The frozen `when=` vocabulary](#the-frozen-when-vocabulary) above,
applied per-workflow rather than per-atom. Six entry points are wired today:
`execute-phase`, `plan-phase`, `new-project`, `new-milestone`, `quick`, and
`progress`.

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

## Piloted on execute-phase.md, then rolled out to plan-phase.md

Two workflows carry markers today: `gsd-core/workflows/execute-phase.md` (the
#2930/Phase-3 pilot) and `gsd-core/workflows/plan-phase.md` (#2993, epic
#1671 Phase 6.2). The marker grammar and composer seam are general-purpose
across any workflow file; rollout to further LARGE/XL workflows remains
sequenced as later work.

`execute-phase.md` marks three `<step>` blocks: `partial-wave`
(`flag:--wave`), `gap-closure-artifacts` (`state:gap-closure-phase`), and
`regression-gate` (`state:has-prior-phases`).

`plan-phase.md` marks six sections: `reviews-prerequisite` (`flag:--reviews`),
`prd-express-gate` (`flag:--prd`), `adr-ingest-express-path` (`flag:--ingest`),
`research-only-modifiers` and `research-only-early-exit` (both
`flag:--research-phase` — two consumers sharing one atom, gated by the same
`RESEARCH_ONLY` condition, so they include/exclude together), and
`chunked-planning-mode` (`state:chunked-mode`).

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
- `src/init.cts` — `buildSectionManifestField` and the six wired
  `cmdInit*` entry points.
