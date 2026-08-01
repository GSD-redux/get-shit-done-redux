# Workflow fragments (reference)

> **Diátaxis quadrant:** Reference. This is the canonical specification of the
> in-file `<!-- gsd:section -->` marker grammar used to fragmentize GSD workflow
> markdown for per-runtime emission. For the surrounding seam (why it exists and
> how it composes with the shared budget composer), see
> [Architecture: Workflow Fragmentization and Emission](../ARCHITECTURE.md#workflow-fragmentization-and-emission-srcworkflow-fragmentscts-adr-1671)
> and [ADR-1671](../adr/1671-dynamic-context-management-platform.md) (open
> questions 1 and 2).

Workflow authors can mark one or more sections of a `gsd-core/workflows/*.md` file
so that `bin/install.js`'s emission path can compose them per runtime. Today this
is an authoring model with no run-time effect yet — see
[Not acted on yet](#not-acted-on-yet) below.

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

`when=` takes exactly one of:

| Value | Meaning |
|---|---|
| `always` | Section is always applicable. |
| `flag:--wave` | Applicable when the workflow runs with `--wave`. |
| `state:gap-closure-phase` | Applicable when the phase number is a gap-closure phase (has a decimal, e.g. `4.1`). |
| `state:has-prior-phases` | Applicable when prior phases (and their `VERIFICATION.md` files) exist. |

This list is **closed by design** (Greenspun's Tenth Rule): left open-ended,
`when=` would acquire boolean operators, negation, precedence, and
runtime/capability predicates one edit at a time, becoming an ad-hoc,
informally-specified applicability language. Widening the vocabulary is a
coordinated ADR amendment to ADR-1671, never an organic edit to the parser.

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

## Not acted on yet

`when=` is parsed and validated today, but applicability selection — actually
choosing which sections apply to a given invocation — is not implemented in
this phase. Every fragment composes into the output regardless of its `when=`
value; only the marker lines are stripped. Run-time selection is planned for
a later phase of ADR-1671's epic.

## Piloted on one workflow so far

Only `gsd-core/workflows/execute-phase.md` carries markers today. The marker
grammar and composer seam are general-purpose across any workflow file, but
rollout to other LARGE/XL workflows is intentionally sequenced as later work,
not part of this phase.

The pilot marks three `<step>` blocks: `partial-wave` (`flag:--wave`),
`gap-closure-artifacts` (`state:gap-closure-phase`), and `regression-gate`
(`state:has-prior-phases`).

**The pilot was retargeted from `plan-phase.md` mid-phase.** Issue #2930's
own motivating mutually-exclusive branches (`--prd`, `--ingest`, `--mvp`,
`--reviews`) all live in `plan-phase.md`, not `execute-phase.md`. But
`plan-phase.md` sits only 36 B under an independent, pre-existing size gate
(`tests/phase6-capstone-conformance.test.cjs`'s `PRE_PHASE6`, an ADR-857
Phase-6 completion property) and cannot absorb any marker overhead at all —
so it could not be fragmentized under this phase's grammar regardless of
branch shape. This is direct evidence for the epic's premise that
fragmentization pays off, and it also means Phase 4 (moving size caps from
source bytes to emitted bytes) may need to land before `plan-phase.md`
itself can be fragmentized. Separately, and independent of the size-gate
finding, `--mvp` would remain unmarkable by this grammar even if the size
gate allowed it: its content in `plan-phase.md` is INTERLEAVED with other
flags rather than living in its own contiguous section (`MVP_MODE`
resolution shares a single bash block with `--tdd`, `--no-tracer`, and
`--no-reversibility-gates` handling at `plan-phase.md:125-158`, and
elsewhere it is inline `${MVP_MODE === 'true' ? ... }` template
interpolation embedded inside the planner prompt at `plan-phase.md:794-803`)
— the marker grammar is closed, non-nesting, and whole-line (see
[Marker syntax](#marker-syntax) above), with no way to wrap part of a line
or split a shared conditional block without either corrupting the
conditional or bundling unrelated flags into one section. See
[ADR-1671](../adr/1671-dynamic-context-management-platform.md) open
question 1's resolution for the full record, and Phase 6 (LARGE/XL rollout)
for how both limits get addressed.

## Related

- [ADR-1671](../adr/1671-dynamic-context-management-platform.md) — the
  platform decision record, including open questions 1 (fragment unit) and 2
  (build-time vs. run-time emission), both resolved by this phase.
- [Architecture: Workflow Fragmentization and Emission](../ARCHITECTURE.md#workflow-fragmentization-and-emission-srcworkflow-fragmentscts-adr-1671).
- `src/workflow-fragments.cts` — the compiled parser/composer source.
- `src/context-composer.cts` — the shared budget-composition seam consumed by
  `composeWorkflow`.
