# ADR-2980: A payload-carried `error` key is a degraded result, not a fault

- **Status:** Accepted
- **Date:** 2026-08-09
- **Issue:** [#2980](https://github.com/open-gsd/gsd-core/issues/2980)
- **Supersedes:** —
- **Relationship to prior work:** Resolves the decision [ADR-2966](2966-loop-qa-walk.md) explicitly deferred when its `soft-error-exit-zero` smell first fired. Constrained by [ADR-1411](1411-resolution-provenance.md) (resolution must report its provenance) and [ADR-227](227-input-validation-shape-not-just-type.md).

## Context

`gsd-tools` reports failure through two different idioms, and they disagree about the exit code.

| Idiom | Stream | Exit | Honors `--json-errors` |
|---|---|---|---|
| `error(message, reason)` | stderr | **1** | yes → `{ok:false,reason,message}` |
| `output({ error: … })` | stdout | **0** | no — it is a payload, not an error envelope |

The second idiom is used at **60 call sites across nine modules**:

| Module | Sites | | Module | Sites |
|---|--:|---|---|--:|
| `src/state.cts` | 25 | | `src/template.cts` | 3 |
| `src/verify.cts` | 8 | | `src/gsd2-import.cts` | 2 |
| `src/workstream.cts` | 7 | | `src/phase.cts` | 2 |
| `src/frontmatter.cts` | 6 | | `src/roadmap.cts` | 2 |
| `src/commands.cts` | 5 | | **Total** | **60** |

> **On the number 42.** [#2966](https://github.com/open-gsd/gsd-core/issues/2966) and
> [#2980](https://github.com/open-gsd/gsd-core/issues/2980) both record this population as *42 sites
> across six modules*. That figure counts only the sites where `error` is the object literal's
> **first** key — the shape a line regex such as `output\(\{\s*error:` matches. Eighteen further
> sites put another key first (`src/roadmap.cts:260` is
> `output({ found: false, error: 'ROADMAP.md not found' }, raw, '')`) and are identical in contract.
> 42 is a real subset, not the size of the contract; the count was re-derived here by brace-matching
> the first argument rather than by line regex. **Do not "correct" 60 back to 42.**

Observable today:

```console
$ gsd-tools state-snapshot          # in a project with no STATE.md
{
  "error": "STATE.md not found"
}
$ echo $?
0
```

`docs/json-errors.md` described only the first idiom. A reader consulting it would conclude that
every `gsd-tools` error goes to stderr with exit 1, and would write the obvious shell caller:

```sh
if ! gsd-tools state-snapshot > snap.json; then
  echo "failed"        # never reached — the process exited 0
fi
```

The failure is visible only to a caller that parses the payload and knows to look for an `error`
key. Workflows invoke `gsd_run <cmd>` and branch on exit status, so the gap is not hypothetical.

This surfaced from the loop QA walk ([ADR-2966](2966-loop-qa-walk.md)) as a `soft-error-exit-zero`
smell — *legal under today's implementation but structurally questionable*. That ADR measured the
blast radius, declined to act inside a QA-harness ADR, and said the question "warrants a separate,
deliberate decision". This is that decision.

### Why it is not simply a bug

Many sites show deliberate intent — an `error` key returned **alongside a valid result**:

```js
// src/roadmap.cts:310 — cmdRoadmapAnalyze
output({ error: 'ROADMAP.md not found', milestones: [], phases: [], current_phase: null }, raw, undefined);

// src/roadmap.cts:260 — cmdRoadmapGetPhase
output({ found: false, error: 'ROADMAP.md not found' }, raw, '');
```

Under that reading exit 0 is correct: the command succeeded in determining that the artifact is
absent. That matches the project's existing guidance for bounded subprocesses —
`CONTEXT.md`'s `DEFECT.UNBOUNDED-SUBPROCESS.fix-forward` prescribes "on timeout return degraded
result + structured warning rather than throw" — and it is the same instinct
[ADR-1411](1411-resolution-provenance.md) encodes: a resolution miss is reported, not thrown.

## Decision

**The payload-carried `error` key is a ratified contract, not an accident. It stays.** All 60 call
sites are unchanged; no code moves.

Precisely, the contract now documented in [`docs/json-errors.md`](../json-errors.md):

> A JSON result on **stdout** carrying an `error` key, with **exit 0**, means the command **ran to
> completion and is reporting a condition through its result**. It is not a process failure. A
> caller that needs to detect it must inspect the payload; the exit code will not tell it, and
> `--json-errors` does not apply.

A **fault** keeps the other path: `error(message, reason)` → stderr, exit 1, structured envelope
under `--json-errors`. Usage errors keep the third: `ExitError` → plain text on stderr, its own
exit code.

**New code should prefer the fault path, or a named-field result.** This ADR ratifies an existing
population; it is not a license to add a 61st site. Where a verb genuinely needs to report a
non-fatal condition in its payload, the richer shape `state update-progress` already uses —
`{"updated": false, "reason": "Progress field not found in STATE.md"}`, with no overloaded `error`
key — is the better model.

### Options declined

**Option 2 — split the vocabulary** (`status: "absent"` in place of `error`). Declined. It buys a
cleaner vocabulary at the same compatibility cost as Option 3: any caller already reading `.error`
stops seeing it, and it still requires sweeping every site.

**Option 3 — normalize every site to exit 1.** Declined on measured blast radius.
`get_impact` rates `cmdStateSnapshot` — the function this idiom threads through — **CRITICAL**:
[ADR-2966](2966-loop-qa-walk.md) recorded 55 affected symbols across 23 processes, and a re-measure on 2026-08-09 at depth 5
reports ≥200 affected symbols across 41 files and 21 processes. `output` itself has **170 direct
callers**. Flipping 0 → 1 across that seam would break every caller currently treating exit 0 as a
soft signal.

That is a textbook **Hyrum's Law** break: the exit-0 behavior is observable, has been in production
across 60 sites, and is therefore depended upon whether or not anything promised it. A CLI's exit
code has no versioning escape hatch — there is no `/v2/` for `$?`. Hyrum's own prescription for a
long-lived observable behavior is to *document what is stable*, which is what this ADR does.

## Consequences

**Good.**

- The idiom is a chosen contract with a written rule, so a caller can be correct on purpose rather
  than by accident. The gap that made the obvious shell caller wrong is closed at the documentation
  layer, which is where it existed.
- Zero risk. No call site, exit code, or payload shape changes.
- [ADR-2966](2966-loop-qa-walk.md)'s ratchet rule — *a smell must terminate in either an assigned defect or a corrected
  detector* — is satisfied through the assigned-defect branch, resolved as "keep".

**Costs, stated plainly.**

1. **The 60 sites are not a uniform population, and the contract is broader than the motivating
   example.** The issue framed the idiom as "an `error` key alongside a valid empty result". That
   shape is real and common — the 18 sites that put another key first are largely it
   (`{found:false, error}`) — but it does not describe the whole population. The rest divide into:
   - *absent artifact* — the largest group; a bare `{error}` or `{error, <echo of the input>}`, e.g.
     `{"error":"STATE.md not found"}`;
   - *missing required argument* — **at least seven** sites, all verified within the error-first
     subset: `src/state.cts` 599, 834, 902, 969, 1080 and 2814 (`'text required'`,
     `'summary required'`, `'phase, plan, and duration required'`,
     `'milestone required (--milestone <vX.Y>)'`) plus `src/template.cts:269`
     (`'File already exists'`). These are faults wearing the degraded shape. Under this ADR they are
     correctly *shaped* but arguably wrongly *classified*. "At least" is deliberate — the 18
     error-not-first sites were not individually classified;
   - *unusable input* — `cmdStateAdvancePlan` (`src/state.cts:553-585`) reports an unparseable
     STATE.md through the same channel as a missing one.

   Reclassifying any of them is a code change and is out of scope here.

2. **Absent and unusable are not distinguishable by exit code.** [ADR-1411](1411-resolution-provenance.md)'s
   2026-07-26 amendment ("corrupt is not absent") requires those classes to stay distinguishable.
   Today only the message text separates them — and the message is explicitly documented as
   unstable, so a caller cannot depend on it. This ADR does not close that gap; it names it.

3. **`--raw` is not uniform on the error path.** `output(result, raw, rawValue)` prints `rawValue`
   only when it is not `undefined`. Most sites pass `undefined` (eight in `src/verify.cts` omit the
   argument entirely), so `--raw` still hands the caller the JSON error object. **Eleven sites pass
   something else** and therefore behave differently under `--raw`: `src/commands.cts` 1481, 1546,
   1553, 1569, `src/phase.cts` 246, 692, `src/roadmap.cts:260`, `src/state.cts:436` and `:2566` pass
   `''` or `'false'`; `src/state.cts:2436` passes the message text; `src/template.cts:100` passes a
   template path. A caller cannot assume either behavior from `--raw` alone.

4. **The `soft-error-exit-zero` smell keeps firing** on `state-snapshot` and `roadmap get-phase`,
   now against behavior this ADR ratifies. Per [ADR-2966](2966-loop-qa-walk.md) §5 a smell never fails a build and never
   folds into `.failed`, so this costs nothing but noise — but a detector reporting a ratified
   contract is reporting a decision, not a finding. Re-pointing it is a code change and is out of
   scope here.

## Revisit if

- A caller needs to distinguish **absent** from **unusable** programmatically. That is
  [ADR-1411](1411-resolution-provenance.md)'s open edge, and it is the most likely reason this
  decision gets reopened. The in-band mechanism that ADR already prescribes — naming the cause in a
  provenance field — would fit these payloads without touching a single exit code, which makes it
  strictly cheaper than Options 2 and 3.
- The missing-required-argument sites (cost 1 above) produce a real caller bug. Those seven are the
  subset with the weakest claim to exit 0, and they could be moved to `error()` on their own, with a
  far smaller radius than the full 60.
- A future `gsd-tools` major version provides a compatibility boundary that a CLI exit code
  otherwise lacks.

## Amendment — 2026-08-27: the compatibility boundary now exists (#3912, ADR-3889 §4)

The third bullet above is answered. [ADR-3889](3889-process-exit-contract.md) §4 gives `gsd-tools`
a versioned exit-contract projection (`v1`/`v2`, selected by `--exit-contract=`/
`GSD_EXIT_CONTRACT=`), and [#3912](https://github.com/open-gsd/gsd-core/issues/3912) is the phase
that lands the projection this idiom's population feeds.

- **`output()` now declares an outcome.** A payload carrying a *serializable* `error` key — any key
  order, `error: undefined` excluded because `JSON.stringify` drops it before the wire — records
  `DEGRADED` into the pending-outcome cell `runMain` reads (`src/cli-exit.cts`, `src/io.cts`).
- **Under `v1` — today's default — nothing here changes anything.** Every ratified site still exits
  `0` byte-for-byte; the declaration is recorded but `projectOutcome` pins `DEGRADED -> 0` under
  `v1` specifically so this ADR's Consequences ("no call site, exit code, or payload shape changes")
  stays true.
- **Under `v2`, a caller that opts in gets a real signal.** `DEGRADED` projects to exit code `80`
  (`exitCodeFor('DEGRADED')`, ADR-3889's registry) — non-zero, so `if ! cmd; then` finally trips on
  this idiom, without moving a single call site or changing the payload shape Option 2/3 above
  declined to touch.
- **The population this ADR ratifies is 64, not 60.** This ADR's own site count was measured by
  brace-matching in 2026-08-09; an AST-based re-measure for #3912 finds the same **nine modules**
  but **64** `output({error})` call sites, not 60 — the drift concentrates in
  `src/frontmatter.cts` (7, not 6), `src/phase.cts` (4, not 2), and `src/roadmap.cts` (3, not 2).
  Do not restate 60 as current: the `v2` `DEGRADED` projection above is asserted over the enumerated
  **64**, and any future re-measure that finds a different count should amend this note rather than
  silently correct the number back.

This does not reopen the Decision above. The 64 sites are still unchanged, still exit `0` under the
default contract, and the richer named-field shape (`state update-progress`'s
`{"updated": false, "reason": …}`) is still the recommended shape for new code. What changes is that
a caller who explicitly asks for `v2` no longer has to parse the payload to notice a degraded
result — the exit code says so.
