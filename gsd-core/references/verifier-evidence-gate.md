# Convergence Evidence Gate (#3304)

Bounds Step 7's anti-pattern scan so an approved gap-closure contract can
actually close. Applies **only** when `is_re_verification = true` (Step 0) —
a first pass has no prior contract to be out-of-contract from, so this gate
is a pure no-op there.

## The problem this closes

Steps 4-7c re-verify at full, unbounded scope on every re-verification pass —
that is documented, intended design, not the bug. The bug is narrower: Step
7's `Categorize:` line lets the verifier's own free-form judgment label
*anything* it believes "prevents goal" a 🛑 Blocker, and Step 9 Rule 1
promotes any 🛑 Blocker straight into `status: gaps_found` — with no
distinction between a blocker tied to what the gap-closure round was actually
supposed to fix and a blocker that is simply a new opinion formed on this
pass. Reported real-world instance: a re-verification cycle promoted four
"architectural and security observations" to blockers, none backed by a
failing test, none traceable to a requirement/decision/prior gap, reverting a
completed, all-green gap-closure round and recommending another `--gaps`
cycle — with no bound on how many times that could repeat.

Truths, artifacts, and key links (Steps 3-6) can **never** produce this
failure mode: Step 0 re-verification mode reuses the must-haves extracted in
Step 2 verbatim ("Skip to Step 3") rather than re-establishing them, so
whatever a truth/artifact/link *is* was fixed before this re-verification
round started. Only Step 7's blanket per-file scan is unbounded by that
must-haves contract — which is exactly the mechanism the issue's diagnosis
names. This gate therefore touches Step 7 only.

## Definitions

**Self-evidencing blocker (unaffected by this gate).** The debt-marker gate
(`TBD`/`FIXME`/`XXX` with no `issue #123`/`PR #123`/`#123`/`DEF-*` reference
on the same line) is the *only* Step 7 category with zero judgment
component — a regex match plus the absence of a follow-up reference, nothing
inferred. Its own textual presence in the file is the deterministic evidence.
It keeps blocking unconditionally, exactly as before. Do **not** extend this
carve-out to any other Step 7 category (stub classification, hollow props,
empty implementations, console-log-only): every one of those already
requires judgment per Step 7's own "Stub classification" paragraph ("a grep
match is a STUB only when the value flows to rendering... and no other code
path populates it with real data") — that judgment is exactly what this gate
exists to check.

**New-scope finding.** Any Step 7 🛑 Blocker other than a self-evidencing one
(above) is a new-scope finding **unless** either of the following holds, in
which case it is in-contract and blocks unconditionally, evidence or not:

1. **Carried-forward gap** — it matches an item in the previous
   VERIFICATION.md's `gaps:` list, using the same 80%-token-overlap matching
   algorithm Step 3b already uses for override matching (normalize to
   lowercase, strip punctuation, collapse whitespace, tokenize, intersect).
2. **Regression** — the flagged file was modified since the previous
   VERIFICATION.md's `verified:` timestamp. Check file-level, not
   line-level — an LLM agent re-deriving precise line provenance mid-pass is
   unreliable; file-level modification is a single, robust command:

   ```bash
   git log --since="$PREV_VERIFIED_TS" --oneline -- "$file"
   ```

   A non-empty result means the file changed since the prior pass — the
   gap-closure round could plausibly have introduced this finding, so it's
   self-evidencing as a regression and blocks. **Fail closed**: if git
   history is unavailable, ambiguous, or the timestamp can't be parsed,
   treat the file as modified (blocks). The imprecision this trades away
   (a big file with one unrelated hunk touched treats every pattern in it as
   "new") only ever makes *more* things block, never fewer — consistent with
   `<adversarial_stance>`.

A finding that is neither a carried-forward gap nor on a file modified since
the prior pass predates the gap-closure round entirely and was never flagged
as a gap then — this is the literal "some findings predated the gap
implementation and had previously been explicitly treated as non-blocking"
case from the issue.

**Deterministic evidence** — required for a new-scope finding to stay
blocking. One of:

- A **named test that FAILS when actually run** (red). Run exactly one test,
  the same discipline Step 7b already uses for behavioral spot-checks —
  never the full suite. Record the exact command and the failing output.
- **Another concrete, reproducible artifact** — a command + output that
  demonstrates the defect (a crash, a probe failure, a reproducible bad
  response). An assertion, opinion, or architectural preference with no test
  and no reproducible command output is not evidence, however well-reasoned.

## The gate

- New-scope finding **with** deterministic evidence → 🛑 Blocker, unchanged.
  This includes evidenced security findings — they are preserved and still
  block.
- New-scope finding **without** deterministic evidence → downgrade out of
  the blocker set. Record it in the `advisory:` frontmatter list (parallel to
  the existing Step 9b `deferred:` list) with its reasoning intact. It does
  **not** count toward Step 9 Rule 1's `gaps_found` trigger and does **not**
  revert a completed must-have or, on its own, justify another
  `/gsd:plan-phase --gaps` cycle.

This changes nothing else: a carried-forward gap or a regression still
blocks with or without a pre-existing requirement to point at, and every
non-Step-7 trigger (FAILED truth, MISSING/STUB artifact, NOT_WIRED link) is
untouched, since those can never be new-scope in the first place.

## What this deliberately does NOT implement

The issue as filed proposed a broader rule: a finding is advisory whenever
it is untraceable to a requirement/decision/prior-gap (conditions A and B),
regardless of evidence. The maintainer approved **condition C only** —
evidence, not contract-traceability, is the bar. A finding with no
pre-existing requirement to point at but with a real failing test still
blocks. Do not implement A/B: that would demote a genuine, reproducible
defect to advisory purely for being newly discovered, which is exactly the
deferral this project's no-defer rule forbids. This gate narrows *when a
blocker needs proof*, not *what counts as in scope*.

## Advisory frontmatter

```yaml
advisory: # Only if new-scope findings lack deterministic evidence (Step 7)
  - finding: "Short description of the new-scope concern"
    category: architectural | security | other
    reason: "Why this was raised; what would resolve it"
    evidence_status: "none provided" # or cite what was attempted but inconclusive
```

## Report section

```markdown
### Advisory (New Scope, Unevidenced)

New-scope findings from Step 7 with no deterministic evidence — reported,
not blocking, do not revert a completed must-have.

| # | Finding | Category | Why Advisory |
|---|---------|----------|--------------|
| 1 | {finding} | {category} | new-scope, no deterministic evidence |
```

Include this section (even if empty, stating "None") whenever
`is_re_verification = true` ran — an omitted section reads as "not
checked," not "checked and clean."

## Worked example (from the issue's reported incident)

Prior pass: `gaps_found`, 4 items — all closed by approved gap-closure plans,
re-verification begins.

- Finding: "the retry loop's backoff strategy is architecturally fragile
  under sustained load." Not in the prior `gaps:` list. The flagged file was
  last modified 3 weeks before this verification pass (before the
  gap-closure plans even started) — not a regression. No test run, no
  reproducible command demonstrating a failure. → **advisory**, does not
  block, does not revert the 4 closed gaps.
- Finding: `TBD: handle the timeout case` left in a file the gap-closure plan
  edited this pass. → self-evidencing debt marker, unaffected by this gate,
  blocks exactly as it always has.
- Finding: a previously-closed gap's file now fails the SAME named test that
  originally proved it broken. → carried-forward gap, blocks.
