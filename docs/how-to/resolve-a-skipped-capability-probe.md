# Resolve a skipped capability probe

A phase-scope probe — the API-coverage detector or the assumption-delta
detector — needs real text to examine before it can assert a verdict. When it
gets none, it says so instead of guessing. This page covers reading that
signal and clearing it.

## What you saw

One of two things, depending on which surface you hit:

- **The seal gate held your phase.** `verify:pre` reported a block with
  `scope_unavailable: true` instead of the usual "no external-API integration
  detected" pass.
- **A planning checkpoint reported `skipped` instead of a verdict.** The
  `assumption-delta` or `api-coverage` plan-time checkpoint printed
  `{"skipped":true,"reason":"..."}` and produced no decision either way.

Both are the same underlying fix (#3909): a probe that never examined real
input used to fabricate `detected:false`, which reads as "nothing here" when
the true answer is "nobody looked." Now it says which one happened.

## The reason-code table

| `reason` | What it means | What actually happened | Remedy |
|---|---|---|---|
| `scope_unavailable` | The seal-time gate found no phase scope at all | No plan body (`.planning/phases/<N>/*-PLAN.md`) *and* no ROADMAP section for the phase | Add the plan or roadmap section, or write a reasoned `No external API integration: <reason>` declaration to `COVERAGE.md` |
| `phase_unresolved` | The `assumption-delta scan` query could not resolve a phase section to scan | No `ROADMAP.md`, an unknown phase number, or a phase section with no body | If you expected a real scan, fix the phase reference or roadmap section; otherwise no action — the checkpoint correctly stays silent |
| `probe_unavailable` | The detector process itself produced no output | The probe crashed, was not found, or its stdout was empty for a reason unrelated to input content | Check that `gsd-core/bin/lib/api-coverage.cjs` or `gsd-core/bin/lib/assumption-delta.cjs` runs standalone; re-run the checkpoint once the probe itself is healthy |
| `no_input` | The detector ran but stdin was empty or whitespace-only | The phase scope resolved to nothing (empty plan body and empty roadmap section) | Same as `scope_unavailable` — give the detector something to read |
| `stdin_error` | The detector could not read stdin at all | A pipe/read failure upstream of the detector, not an empty-input case | Re-run; if it recurs, the caller constructing `$SCOPE` is the thing to fix, not the detector |

## The seal gate held my phase

1. Confirm the reason directly:

   ```bash
   gsd_run check api-coverage.verify-pre <phase> --raw
   ```

   Look for `"scope_unavailable": true` in the output. That confirms this is
   the fail-closed arm, not a real "integration detected" block.

2. Check whether the phase actually has scope to read:

   ```bash
   ls .planning/phases/<N>/*-PLAN.md 2>/dev/null
   gsd_run query roadmap.get-phase <phase>
   ```

   If both come back empty, the gate is correct — there is genuinely nothing
   for the detector to examine.

3. Resolve it one of two ways:
   - **Add the missing scope.** Write the phase plan, or add the phase's
     section to `ROADMAP.md`, then re-run detection.
   - **Record the reasoned declaration anyway.** If the phase truly has no
     plan body worth writing (rare), put the human decision directly in
     `COVERAGE.md`:

     ```markdown
     No external API integration: <one-line reason>.
     ```

     This is the same reasoned overrule the gate already accepts when a
     detector *does* find (or falsely flags) a signal — see
     [`gsd-core/references/api-coverage.md`](../../gsd-core/references/api-coverage.md#declaring-no-external-api-integration-2365).

4. Re-run the gate to confirm it clears:

   ```bash
   gsd_run check api-coverage.verify-pre <phase> --raw
   ```

**Turning the gate off does not answer the question.** Setting
`workflow.api_coverage_gate: false` in `.planning/config.json` silences the
hold, but the phase's API surface is still undecided — you have just stopped
being told. Prefer resolving the scope or writing the declaration.

## A checkpoint reported skipped

The `assumption-delta` and `api-coverage` plan-time checkpoints are advisory:
when they cannot resolve a phase section, they skip rather than fire, and that
is correct, non-blocking behavior. You do not need to do anything except
notice that the phase was not actually cleared by a real scan — a `skipped`
payload carries no `detected` key and is not the same as "no signal found."
If you expected a real scan and got a skip instead, treat it like the
`phase_unresolved` row above: check that the phase reference and roadmap
section actually exist.

## Why this is not just a stricter gate

A probe reporting `detected:false` from an input it never read is a false
negative on a *blocking* gate — the one direction a gate must never fail
silently. A false positive here costs one line in `COVERAGE.md`; a false
negative lets a real external-API integration seal with an undecided surface,
discovered later by a user who reasonably expected it to work. This change can
turn a false green red. It can never turn a red green — every phase that
passed because a signal was genuinely absent from scope the detector actually
read still passes, unchanged.

## Telling "nothing to report" apart from "could not look"

This is the recurring distinction across this doc set (see also
[Resolve unreachable-guard findings](resolve-unreachable-guard-findings.md) and
[Consume the planning snapshot](consume-the-planning-snapshot.md)). A verdict
of `detected: false` or `passed: true` means the detector examined real text
and found nothing. A `skipped` payload or a `scope_unavailable` block means
the detector examined nothing at all. Only the first is good news; the second
is a request for more scope, not a clean bill of health.

## Related

- [`gsd-core/references/api-coverage.md`](../../gsd-core/references/api-coverage.md) — the full API-coverage gate reference, including the seal-time outcome table
- [Resolve unreachable-guard findings](resolve-unreachable-guard-findings.md) — the same "nothing to report vs. could not look" distinction, one layer down
- [Consume the planning snapshot](consume-the-planning-snapshot.md) — the `scope` field's version of this same rule
