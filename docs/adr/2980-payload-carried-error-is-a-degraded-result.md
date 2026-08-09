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

The second idiom is used at **42 call sites** across six modules — `src/state.cts`,
`src/verify.cts`, `src/frontmatter.cts`, `src/roadmap.cts`, `src/template.cts`, `src/commands.cts`.
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

`src/roadmap.cts:310` shows deliberate intent — an `error` key returned **alongside a valid empty
result**:

```js
output({ error: 'ROADMAP.md not found', milestones: [], phases: [], current_phase: null }, raw, undefined);
```

Under that reading exit 0 is correct: the command succeeded in determining that the artifact is
absent. That matches the project's existing guidance for bounded subprocesses —
`CONTEXT.md`'s `DEFECT.UNBOUNDED-SUBPROCESS.fix-forward` prescribes "on timeout return degraded
result + structured warning rather than throw" — and it is the same instinct
[ADR-1411](1411-resolution-provenance.md) encodes: a resolution miss is reported, not thrown.

## Decision

**The payload-carried `error` key is a ratified contract, not an accident. It stays.** The 42 call
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
population; it is not a licence to add a 43rd site. Where a verb genuinely needs to report a
non-fatal condition in its payload, the richer shape `state update-progress` already uses —
`{"updated": false, "reason": "Progress field not found in STATE.md"}`, with no overloaded `error`
key — is the better model.

### Options declined

**Option 2 — split the vocabulary** (`status: "absent"` in place of `error`). Declined. It buys a
cleaner vocabulary at the same compatibility cost as Option 3: any caller already reading `.error`
stops seeing it, and it still requires sweeping every site.

**Option 3 — normalize the 42 sites to exit 1.** Declined on measured blast radius.
`get_impact` rates `cmdStateSnapshot` — the function this idiom threads through — **CRITICAL**:
ADR-2966 recorded 55 affected symbols across 23 processes, and a re-measure on 2026-08-09 at depth 5
reports ≥200 affected symbols across 41 files and 21 processes. `output` itself has **170 direct
callers**. Flipping 0 → 1 across that seam would break every caller currently treating exit 0 as a
soft signal.

That is a textbook **Hyrum's Law** break: the exit-0 behavior is observable, has been in production
across 42 sites, and is therefore depended upon whether or not anything promised it. A CLI's exit
code has no versioning escape hatch — there is no `/v2/` for `$?`. Hyrum's own prescription for a
long-lived observable behavior is to *document what is stable*, which is what this ADR does.

## Consequences

**Good.**

- The idiom is a chosen contract with a written rule, so a caller can be correct on purpose rather
  than by accident. The gap that made the obvious shell caller wrong is closed at the documentation
  layer, which is where it existed.
- Zero risk. No call site, exit code, or payload shape changes.
- ADR-2966's ratchet rule — *a smell must terminate in either an assigned defect or a corrected
  detector* — is satisfied through the assigned-defect branch, resolved as "keep".

**Costs, stated plainly.**

1. **The 42 sites are not a uniform population, and the contract is broader than the motivating
   example.** Exactly one site (`src/roadmap.cts:310`) has the "error key alongside a valid empty
   result" shape the issue described. The rest divide into:
   - *absent artifact* — the majority; a bare `{error}` or `{error, <echo of the input>}`;
   - *missing required argument* — roughly nine sites (`'text required'`, `'summary required'`,
     `'milestone required (--milestone <vX.Y>)'`, `'File already exists'`). These are faults wearing
     the degraded shape. Under this ADR they are correctly *shaped* but arguably wrongly
     *classified*;
   - *unusable input* — `cmdStateAdvancePlan` (`src/state.cts:553-585`) reports an unparseable
     STATE.md through the same channel as a missing one.

   Reclassifying any of them is a code change and is out of scope here.

2. **Absent and unusable are not distinguishable by exit code.** [ADR-1411](1411-resolution-provenance.md)'s
   2026-07-26 amendment ("corrupt is not absent") requires those classes to stay distinguishable.
   Today only the message text separates them — and the message is explicitly documented as
   unstable, so a caller cannot depend on it. This ADR does not close that gap; it names it.

3. **`--raw` does not yield bare text on the error path.** `output(result, raw, rawValue)` prints
   `rawValue` only when it is not `undefined`, and 40 of the 42 sites pass `undefined`. A caller
   using `--raw` still receives the JSON error object. Two sites differ: `src/state.cts:436` passes
   `''` and `src/state.cts:2436` passes the message text.

4. **The `soft-error-exit-zero` smell keeps firing** on `state-snapshot` and `roadmap get-phase`,
   now against behavior this ADR ratifies. Per ADR-2966 §5 a smell never fails a build and never
   folds into `.failed`, so this costs nothing but noise — but a detector reporting a ratified
   contract is reporting a decision, not a finding. Re-pointing it is a code change and is out of
   scope here.

## Revisit if

- A caller needs to distinguish **absent** from **unusable** programmatically. That is
  [ADR-1411](1411-resolution-provenance.md)'s open edge, and it is the most likely reason this
  decision gets reopened. The in-band mechanism that ADR already prescribes — naming the cause in a
  provenance field — would fit these payloads without touching a single exit code, which makes it
  strictly cheaper than Options 2 and 3.
- The missing-required-argument sites (cost 1 above) produce a real caller bug. Those nine are the
  subset with the weakest claim to exit 0, and they could be moved to `error()` on their own, with a
  far smaller radius than the full 42.
- A future `gsd-tools` major version provides a compatibility boundary that a CLI exit code
  otherwise lacks.
