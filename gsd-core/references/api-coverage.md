# API Coverage Gate (Full Coverage by Default — Opt Out, Never Opt In)

> Reference for the `api-coverage` gate on the `ai-integration` capability (#1562).
> Config key: `workflow.api_coverage_gate` (default `true`). Gate point: `verify:pre`.

## The problem this closes

"We integrated the API" too often silently means "we integrated whatever the
first use case exercised." Every un-built capability is then an invisible hole,
discovered later by a user who reasonably expected it to work. The phase sealed
green because its tasks completed — nobody *decided* the gaps were acceptable,
because nobody *enumerated* them.

This gate makes the API surface **visible and decided** before the phase can
seal. Full coverage is the default starting position; the coverage matrix is the
*subtraction record*. Every gap is an explicit, reasoned opt-out rather than a
surprise.

## When it fires

The gate runs at `verify:pre` (before `/gsd:verify-work` begins UAT). A phase is
treated as an external-API integration when **either**:

1. a `COVERAGE.md` matrix is present in the phase directory (the planner produced
   one at `plan:pre`), **or**
2. the phase scope shows a strong external-API-integration signal (an integration
   verb and an external-API noun **in the same clause**, or an explicit
   `<Service> API|SDK|REST|GraphQL` surface naming a real service) and no matrix
   yet exists.

The detector is deliberately **fail-closed**: it leans toward firing, because a
false positive is dismissed by a one-line `COVERAGE.md` "no external API
integration" declaration, whereas a false *negative* silently lets a real
external-API phase past this blocking gate — strictly worse. So it suppresses
only prose that is unambiguously not external integration. A bare word like
"api" in "the public API of UserController" is ignored (no integration verb +
named service); the clause boundary is the whole relationship test, so an
integration verb and an API noun in **different** clauses do not pair. Since
#2365 the detector also excludes non-prose spans before matching: fenced code
blocks, inline `` `code` `` spans, and path-shaped tokens (a first-party
`src/app/api/profile/route.ts` route is a file path, not an external API, while
an external host like `api.stripe.com/v1` still counts). In the
`<Service> API` surface position it rejects capitalized sentence starters
("The API"), locality/protocol descriptors ("Internal API", "REST API"),
compound modifiers ("Resolver-only API"), and first-party-qualified services
("internal Payments API") — a real vendor name is none of these.

## The two touch points

1. **Plan time (`plan:pre`).** A contribution to the planner prompts it to run
   the deterministic detector over the phase scope and, when an integration is
   detected, produce `COVERAGE.md`. See
   `capabilities/ai-integration/fragments/api-coverage-plan-pre.md`.
2. **Seal time (`verify:pre`).** The blocking `api-coverage.verify-pre` gate
   runs `check api-coverage.verify-pre <phase-dir>` and blocks unless a valid
   matrix exists (or no integration is detected in a scope it could actually
   read).

### Seal-time outcomes

| Condition | Verdict |
|---|---|
| Valid `COVERAGE.md` matrix | pass |
| `No external API integration: <reason>` declaration | pass (the reasoned human overrule) |
| Malformed / partial matrix | **block** |
| No matrix, integration signal found | **block** |
| No matrix, no signal, scope was read | pass |
| No matrix, **scope could not be established** | **block** — `scope_unavailable: true` (#3909) |
| Phase token unresolvable | **block** |
| Plan file exists but unreadable | **block** |
| No `.planning/phases` tree at all | pass — not a GSD project layout |

The last four are the fail-closed arms: the gate refuses to certify "no
external-API integration" from scope it did not read. A phase with real plans
and no API vocabulary is the fifth row, and is unaffected.

## The coverage matrix format

Canonical form — a markdown table (human-editable, diff-friendly):

```markdown
# API Coverage — <service>

> Full coverage by default. Opt-outs are explicit, reasoned decisions.

| capability | decision | reason |
|---|---|---|
| search | INTEGRATE | |
| playlists | INTEGRATE | |
| skip | OPT-OUT | not needed yet — tracked for follow-up phase |
```

- **`INTEGRATE` is the default.** Every capability starts as INTEGRATE.
- **Every `OPT-OUT` MUST carry a one-line reason** (`not needed`, `not needed
  yet`, `explicitly out of scope`, …). An opt-out without a reason is an
  un-decided hole — the exact failure mode this gate exists to close.
- A fenced ` ```coverage ` JSON block (`[{"capability":…,"decision":…,"reason":…}]`)
  is also accepted for machine-generated matrices.

Rules enforced at seal time: the matrix must be non-empty; every capability name
must be non-empty and unique; every decision must be `INTEGRATE` or `OPT-OUT`;
every `OPT-OUT` must have a reason. Violations block the seal with a precise
error.

### Declaring "no external API integration" (#2365)

A phase that integrates no external API/SDK/service — but was still asked for a
matrix (e.g. the detector over-fired, or a team wants the decision on record) —
declares it instead of fabricating a row:

```markdown
No external API integration: UI-only phase, no third-party surface.
```

The reason is **required**, exactly like an `OPT-OUT` reason — the declaration
is a reasoned decision, not a bypass. A `COVERAGE.md` containing both the
declaration and coverage rows is contradictory and blocks the seal. When the
detector still finds integration signals in the phase scope, the declaration
wins (it is the human overrule for a fallible detector) but the gate output
surfaces the overridden signals so the contradiction is visible, not silent.

## A second integration against the same need

A second platform for an existing capability (e.g. adding YouTube alongside
Spotify for media playback) starts from the **same full-coverage baseline** as
the first. Do not carry over the first integration's opt-outs silently —
re-decide each capability for the new surface, so a first-class/fallback
asymmetry cannot accumulate into a later user-facing bug.

## The matrix persists

`COVERAGE.md` is a phase artifact. A future phase that extends the same
integration starts from the recorded surface and decisions rather than from
zero — the matrix is the durable subtraction record.

## Tuning

- **Disable entirely:** set `workflow.api_coverage_gate: false` in
  `.planning/config.json` (the gate unregisters from `verify:pre`).
- **Widen the trigger vocabulary:** the detector accepts `--verbs` / `--nouns`
  overrides (see `capabilities/ai-integration/fragments/api-coverage-plan-pre.md`).
  The default vocabulary is additive-only.

## Detector CLI

```bash
echo "$PHASE_SCOPE" | node gsd-core/bin/lib/api-coverage.cjs --json
# exit 0 = integration detected, 1 = none (real input, examined, no signal)
# NO_INPUT = stdin was empty or whitespace-only (registry code — ADR-3889 Phase 3, #3907)
# UNAVAILABLE = stdin read failed (registry code)
# NO_INPUT/UNAVAILABLE emit {"skipped":true,"reason":"no_input"|"stdin_error"} — no `detected` key
```

The detector is a pure function (`detectApiIntegration` → `{ detected, signals,
terms }`) shared by the plan-time prompt and the seal-time gate, so the
low-false-positive guarantee is testable rather than a judgment call.
