# Review Dispositions Ledger canonizes where and how reviews-mode records incorporate/defer decisions in PLAN.md

- **Status:** Accepted
- **Date:** 2026-09-05
- **Issue:** #3806
- **Implementation:** PR #4345

## Context

Since v1.5.0 (#724/#728), reviews-mode planning requires every current actionable REVIEWS.md
finding to be either incorporated into executable PLAN.md content or explicitly
deferred/rejected with a rationale recorded in that PLAN.md
(`gsd-core/workflows/plan-phase.md` `<review_incorporation_contract>`;
`agents/gsd-plan-checker.md` Review Incorporation dimension). That content requirement has held up
well. What it never specified is *where in PLAN.md*, *in what shape*, or *how a REVIEWS.md line
reference survives the next round* — `gsd-core/workflows/review.md`'s `/gsd:review` step rewrites
each phase's `<NN>-REVIEWS.md` wholesale on every cycle, so a bare line-number citation from round 1
resolves against different content by round 3.

In practice, this produced exactly the failure an unspecified format invites: across two
consecutive `/gsd-review` → `/gsd-plan-phase {N} --reviews` rounds of the same phase, two
different planner subagent instances each independently improvised a disposition format. Round 1
invented `## Review Dispositions (developer-ruled)` with `[REVIEW DISPOSITION] …` lines; round 2
invented a second, incompatible `## Review Scope Disposition (requester lock)` with
`AUTHORIZED`/`REJECTED` bullets citing bare `R2-L32`-style line numbers. Both now coexist in the
same PLAN files. Neither is self-sufficient: entries reference conversation-only context (a
mandated "ten fixes" that exists nowhere on disk) and bare line numbers into a file that has since
been rewritten twice more.

The canon gap is real, not a one-off misuse: `gsd-core/references/planner-reviews.md` Step 4
already defines a return-payload shape for this exact information —

```markdown
### Review Feedback Addressed

| Concern | Severity | How Addressed |
|---------|----------|---------------|
| {concern} | HIGH | Plan {N}, Task {M}: {how} |

### Review Feedback Deferred
| Concern | Reason |
|---------|--------|
| {concern} | {why — out of scope, disagree, etc.} |
```

— but it was scoped to the planner's *return message to the orchestrator*, never promoted into
the PLAN.md file content the content requirement actually governs. Each fresh planner subagent
therefore had nothing on disk to imitate and improvised its own shape, twice.

## Decision

Promote the existing Step 4 tables, verbatim in shape, into a canonical `## Review Dispositions
Ledger` section that reviews-mode planners write **into the affected PLAN.md itself** — not a new
line grammar. The ledger groups entries by round: one `### Round {N} — {REVIEWS_sha}` subsection
per reviews-mode cycle that touched the plan, where `{REVIEWS_sha}` is the commit that wrote that
round's REVIEWS.md snapshot (`workflows/review.md` already commits REVIEWS.md as its own commit —
`git log -1 --format=%h -- <phase_dir>/<NN>-REVIEWS.md` gives a real, addressable sha). Any
REVIEWS.md line reference cites `L##@{REVIEWS_sha}`; a bare line number is non-conforming, because
it silently resolves against whatever REVIEWS.md happens to contain by the time someone reads it.
The ledger is append-only: a later round never edits or deletes an earlier round's tables, and
overturning a prior verdict means adding a new row that names what it supersedes.

The contract is stated **once**, in `gsd-core/references/planner-reviews.md` (the stable seam — 3
commits total on `next`, versus 51 and 57 on `plan-phase.md` and `gsd-plan-checker.md`
respectively). `gsd-core/workflows/plan-phase.md`'s `<review_incorporation_contract>` and
`agents/gsd-plan-checker.md`'s Review Incorporation dimension both *reference* the canonical
section by name and point at `planner-reviews.md` for its shape, rather than restating it — each
keeps only the workflow/checker-specific logic that genuinely belongs to it (when a finding counts
as current-actionable, BLOCKER vs. WARNING severity). A parity test
(`tests/plan-review-convergence.test.cjs`, describe block `'plan-review-convergence reviews-mode
ledger canonicalization (#3806)'`) extracts the live heading text from `planner-reviews.md` and
asserts both referencing files still name it, and that neither restates a competing `##`-level
heading of the same name — so a rename in the canon that isn't mirrored in the references fails
the build instead of drifting silently.

`{Concern}`/`{Reason}` stay free text. The reviewer roster is capability-owned — twelve
capabilities each declare a `reviewer` block with `reviewsSection`, and third-party capabilities
can add reviewers — so a closed enum for the reviewer or severity field would be wrong by
construction the moment a new capability ships one.

## What stays OUTSIDE this decision

- **A deterministic lint/check verb enforcing this shape.** Two ad-hoc, mutually incompatible
  formats already exist in the wild (the round-1/round-2 improvisations above). A hard-failing
  lint shipped today would redden every existing PLAN.md carrying either of them before a
  legacy-migration story (warn-then-fail, or scope enforcement to post-adoption entries) has been
  decided. That is real, separate design work, explicitly deferred to a follow-up.
- **Changing what reviews-mode *requires*.** The #724/#728 content contract — every current
  actionable finding must be incorporated or explicitly deferred/rejected in PLAN.md — is
  unchanged. This decision only canonizes the shape of that existing requirement's rejection
  records.
- **`/gsd:execute-phase`'s consumption of PLAN.md.** The ledger remains audit trail and feedback
  input, exactly as REVIEWS.md itself is (`workflows/plan-phase.md`'s existing framing); the
  executor does not read or depend on it.
- **Migrating or flagging legacy PLAN.md content.** The two ad-hoc formats already produced by
  prior reviews-mode rounds are untouched by this decision.

## Consequences

- Reviews-mode planners across separate subagent instances and separate rounds now have a single,
  concrete, on-disk shape to imitate instead of improvising one from prose alone — closing the gap
  that produced two incompatible formats in the first reproduction.
- A REVIEWS.md line reference is addressable independent of how many times `/gsd:review` has
  rewritten the file since, because it is pinned to the commit that produced the round it came
  from.
- **Duplication risk is named, not just avoided.** `plan-phase.md` and `gsd-plan-checker.md`
  already carried near-identical prose about "explicitly document a deferral/rejection rationale"
  before this change; both now point at one canonical source instead of each independently
  describing the shape, and the parity test is the mechanical guard against the two drifting apart
  again the way the underlying prose already had.
- **This is a documentation/prompt-contract change with no runtime behavior change.** No `src/**`
  code is touched; no new CLI verb exists yet. The follow-up lint (out of scope here) is what would
  eventually make the shape mechanically enforced rather than convention-only.
- A stale `Proposed` never applies here: the decision and its full implementation (the canon plus
  both references plus the parity test) land in this same PR, matching the precedent set by
  [ADR-766](766-claude-code-plugin-manifest-module.md) ("this ADR + the hand-authored manifest land
  first").

## Open questions

- Should the deferred lint (#3806 part 2) hard-fail new entries immediately while only
  warning on legacy ones, or gate on an adoption date? Left to that follow-up's own design.
- Should the ledger's per-round subsections eventually be machine-summarizable (e.g. a `check`
  verb reporting "N concerns still open across M rounds")? Same follow-up.

## References

- Issue #3806 — original report, with the two reproduced disposition formats and the maintainer's
  Go-with-conditions verdict scoping this decision to part 1 (canon only).
- `gsd-core/references/planner-reviews.md` — the canonical statement of the ledger contract.
- `gsd-core/workflows/plan-phase.md` `<review_incorporation_contract>` — references the canon.
- `agents/gsd-plan-checker.md` Review Incorporation dimension — references the canon.
- `gsd-core/workflows/review.md` — commits each round's REVIEWS.md snapshot, the anchor the
  `L##@{sha}` format points at.
- `tests/plan-review-convergence.test.cjs` — parity test locking the three seams together, and the
  pre-existing `#724` contract tests this decision does not change.
- #724 / #728 — established the content requirement this decision only gives a canonical shape to.
- [ADR-766](766-claude-code-plugin-manifest-module.md) — precedent for an ADR and its full
  implementation landing in the same PR.
