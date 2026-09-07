---
id: 3806
title: Review Dispositions Ledger
group: Planning Features
---

**Purpose:** Reviews-mode planning (`/gsd-plan-phase {N} --reviews`) has required every current
actionable REVIEWS.md finding to be incorporated into PLAN.md or explicitly deferred/rejected
there since v1.5.0 (#724/#728). Nothing canonized *where* in PLAN.md, *what shape*, or how a
REVIEWS.md line reference survives the next round rewriting the file wholesale. Two
independently-invented, mutually incompatible disposition formats were observed across two
consecutive rounds of the same phase, each written by a different planner subagent instance
improvising from prose alone.

**Behavior:** The existing return-payload tables from `references/planner-reviews.md` Step 4 —
`### Review Feedback Addressed` / `### Review Feedback Deferred` — are now the canonical
**Review Dispositions Ledger**, promoted verbatim in shape into the affected PLAN.md itself under
a `## Review Dispositions Ledger` heading. Each reviews-mode round gets its own
`### Round {N} — {REVIEWS_sha}` subsection, where `{REVIEWS_sha}` is the commit that wrote that
round's REVIEWS.md snapshot (`workflows/review.md` already commits REVIEWS.md as its own commit).
A REVIEWS.md line reference cites `L##@{REVIEWS_sha}`; a bare line number is non-conforming. The
ledger is append-only — a later round adds a new row naming what it supersedes rather than editing
or deleting an earlier round's tables.

The contract is stated once, in `references/planner-reviews.md`; `workflows/plan-phase.md`'s
`<review_incorporation_contract>` and `agents/gsd-plan-checker.md`'s Review Incorporation dimension
both reference it by name rather than restating it, guarded by a parity test
(`tests/plan-review-convergence.test.cjs`) that fails if the three drift apart.

`{Concern}`/`{Reason}` stay free text — the reviewer roster is capability-owned and open to
third-party additions, so no closed reviewer/severity enum is introduced.

**Known limits:** No lint or check verb enforces this shape yet — a follow-up (tracked as part 2
of #3806) will add deterministic enforcement once a migration story for the two pre-existing ad-hoc
formats already in the wild is decided. Legacy PLAN.md content written before this convention is
not migrated or flagged.

**Reference:** [ADR-3806](adr/3806-review-dispositions-ledger.md) · [Cross-AI Peer Review](#42-cross-ai-peer-review)
