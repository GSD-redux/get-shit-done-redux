---
type: Changed
pr: 0
---
**The plan drift guard now flags the same fact stated two ways** — when ROADMAP.md, PLAN.md, STATE.md and CONTEXT.md contradict each other about a phase status, a success criterion, a requirement ID or a domain term, plan review reports it in REVIEWS.md naming both locations and which one is authoritative, instead of letting a fresh-context agent act on the stale copy. Advisory only; it never blocks convergence, and it keys on contradicting knowledge rather than similar-looking text. Runs under the existing `plan_review.source_grounding` switch — no new setting. (#1956)
